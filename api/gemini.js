export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { model, contents, generationConfig, apiKeys, apiKey, stream } = req.body;
    const modelName = fixModelName(model || 'gemini-2.5-flash');

    // ===== STREAMING MODE =====
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Try Pollinations streaming first (free, no key needed)
      try {
        const messages = convertGeminiToOpenAI(contents);
        const pollRes = await fetch('https://text.pollinations.ai/openai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'openai',
            messages: messages,
            temperature: generationConfig?.temperature || 0.3,
            max_tokens: generationConfig?.maxOutputTokens || 4000,
            stream: true
          })
        });

        if (pollRes.ok && pollRes.body) {
          const reader = pollRes.body.getReader();
          const decoder = new TextDecoder();

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') {
                  res.write('data: [DONE]\n\n');
                  continue;
                }
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.choices && parsed.choices[0] && parsed.choices[0].delta) {
                    const text = parsed.choices[0].delta.content || '';
                    if (text) {
                      res.write(`data: ${JSON.stringify({ text })}\n\n`);
                    }
                  }
                } catch (e) {}
              }
            }
          }
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
      } catch (pollErr) {
        console.log('Pollinations stream failed:', pollErr.message);
      }

      // Fallback to Gemini streaming
      let keys = [];
      if (apiKeys && Array.isArray(apiKeys) && apiKeys.length > 0) {
        keys = apiKeys.filter(k => k && k.trim());
      } else if (apiKey) {
        keys = [apiKey];
      }

      if (keys.length === 0) {
        res.write(`data: ${JSON.stringify({ error: 'No API key available for streaming. Pollinations is also unavailable.' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const currentKey = keys[0];

      try {
        const gemRes = await fetch(
          `https://generativelanguage.googleapis.com/v1/models/${modelName}:streamGenerateContent?key=${currentKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: contents || [{ parts: [{ text: 'hi' }] }],
              generationConfig: generationConfig || { temperature: 0.3, maxOutputTokens: 8192 }
            })
          }
        );

        if (gemRes.ok && gemRes.body) {
          const reader = gemRes.body.getReader();
          const decoder = new TextDecoder();

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            // Gemini returns NDJSON (newline-delimited JSON), not SSE
            const lines = chunk.split('\n').filter(l => l.trim());

            for (const line of lines) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.candidates && parsed.candidates[0] && parsed.candidates[0].content) {
                  const text = parsed.candidates[0].content.parts[0]?.text || '';
                  if (text) {
                    res.write(`data: ${JSON.stringify({ text })}\n\n`);
                  }
                }
                if (parsed.error) {
                  res.write(`data: ${JSON.stringify({ error: parsed.error.message || 'Gemini error' })}\n\n`);
                }
              } catch (e) {}
            }
          }
        } else {
          const errData = await gemRes.json().catch(() => ({}));
          res.write(`data: ${JSON.stringify({ error: errData.error?.message || 'Gemini stream failed with status ' + gemRes.status })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;

      } catch (err) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
    }

    // ===== NON-STREAMING MODE =====
    // Try Pollinations first
    try {
      const messages = convertGeminiToOpenAI(contents);
      const pollRes = await fetch('https://text.pollinations.ai/openai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'openai',
          messages: messages,
          temperature: generationConfig?.temperature || 0.3,
          max_tokens: generationConfig?.maxOutputTokens || 4000
        })
      });

      if (pollRes.ok) {
        const pollData = await pollRes.json();
        const geminiFormat = {
          candidates: [{
            content: {
              parts: [{ text: pollData.choices[0].message.content }],
              role: 'model'
            },
            finishReason: 'STOP',
            index: 0
          }]
        };
        res.status(200).json(geminiFormat);
        return;
      }
    } catch (pollErr) {
      console.log('Pollinations failed:', pollErr.message);
    }

    // Fallback to Gemini
    let keys = [];
    if (apiKeys && Array.isArray(apiKeys) && apiKeys.length > 0) {
      keys = apiKeys.filter(k => k && k.trim());
    } else if (apiKey) {
      keys = [apiKey];
    }

    if (keys.length === 0) {
      res.status(400).json({ 
        error: 'No AI provider available. Pollinations.AI failed and no Gemini API key is configured. Add a Gemini API key in Admin settings or try again later.' 
      });
      return;
    }

    const maxRetries = 3;
    const baseDelay = 2000;
    let lastError = null;

    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      const currentKey = keys[keyIndex];
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const response = await fetch(
            `https://generativelanguage.googleapis.com/v1/models/${modelName}:generateContent?key=${currentKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: contents || [{ parts: [{ text: 'hi' }] }],
                generationConfig: generationConfig || { temperature: 0.3, maxOutputTokens: 8192 }
              })
            }
          );

          const data = await response.json();

          if (response.status === 429) {
            const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }

          if (!response.ok) {
            throw new Error(data.error?.message || 'HTTP ' + response.status);
          }

          res.status(200).json(data);
          return;

        } catch (fetchError) {
          lastError = fetchError;
          if (attempt < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, baseDelay * Math.pow(2, attempt)));
          }
        }
      }
    }

    res.status(429).json({
      error: 'All API keys rate limited or invalid. Please add more API keys or wait a few minutes.',
      details: lastError?.message
    });

  } catch (error) {
    console.error('Handler error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

function convertGeminiToOpenAI(contents) {
  return (contents || []).map(item => ({
    role: item.role === 'model' ? 'assistant' : item.role,
    content: item.parts && item.parts[0] ? item.parts[0].text : ''
  }));
}

function fixModelName(model) {
  const deprecated = {
    'gemini-pro': 'gemini-2.5-flash',
    'gemini-1.5-pro': 'gemini-2.5-flash',
    'gemini-1.5-flash': 'gemini-2.5-flash',
    'gemini-1.5-flash-latest': 'gemini-2.5-flash',
    'gemini-flash-latest': 'gemini-2.5-flash',
    'gemini-2.0-flash': 'gemini-2.5-flash'
  };
  if(deprecated[model]) return deprecated[model];
  return model || 'gemini-2.5-flash';
}
