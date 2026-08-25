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

      let textSent = false;

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
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data: ')) continue;

              const data = trimmed.slice(6);
              if (data === '[DONE]') continue;

              try {
                const parsed = JSON.parse(data);
                if (parsed.choices?.[0]?.delta?.content) {
                  const text = parsed.choices[0].delta.content;
                  res.write(`data: ${JSON.stringify({ text })}\n\n`);
                  if (res.flush) res.flush();
                  textSent = true;
                }
              } catch (e) {}
            }
          }

          if (!textSent && buffer.trim()) {
            try {
              const parsed = JSON.parse(buffer.trim());
              if (parsed.choices?.[0]?.message?.content) {
                const text = parsed.choices[0].message.content;
                res.write(`data: ${JSON.stringify({ text })}\n\n`);
                if (res.flush) res.flush();
                textSent = true;
              }
            } catch (e) {}
          }

          if (textSent) {
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
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
        res.write(`data: ${JSON.stringify({ error: 'No API key available. Pollinations unavailable and no Gemini key configured.' })}\n\n`);
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
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;

              try {
                const parsed = JSON.parse(trimmed);
                if (parsed.error) {
                  res.write(`data: ${JSON.stringify({ error: parsed.error.message || 'Gemini error' })}\n\n`);
                  if (res.flush) res.flush();
                  continue;
                }

                if (parsed.candidates?.[0]?.content?.parts?.[0]?.text) {
                  const text = parsed.candidates[0].content.parts[0].text;
                  res.write(`data: ${JSON.stringify({ text })}\n\n`);
                  if (res.flush) res.flush();
                }
              } catch (e) {}
            }
          }

          if (buffer.trim()) {
            try {
              const parsed = JSON.parse(buffer.trim());
              if (parsed.candidates?.[0]?.content?.parts?.[0]?.text) {
                const text = parsed.candidates[0].content.parts[0].text;
                res.write(`data: ${JSON.stringify({ text })}\n\n`);
                if (res.flush) res.flush();
              }
            } catch (e) {}
          }
        } else {
          const errData = await gemRes.json().catch(() => ({}));
          res.write(`data: ${JSON.stringify({ error: errData.error?.message || 'Gemini stream failed: ' + gemRes.status })}\n\n`);
        }

        res.write('data: [DONE]\n\n');
        res.end();
        return;

      } catch (err) {
        res.write(`data: ${JSON.stringify({ error: 'Gemini error: ' + err.message })}\n\n`);
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
        const text = pollData.choices?.[0]?.message?.content;
        if (text && text.trim()) {
          const geminiFormat = {
            candidates: [{
              content: { parts: [{ text }], role: 'model' },
              finishReason: 'STOP',
              index: 0
            }]
          };
          res.status(200).json(geminiFormat);
          return;
        }
      }
    } catch (pollErr) {
      console.log('Pollinations non-stream failed:', pollErr.message);
    }

    // Fallback to Gemini non-streaming
    let keys = [];
    if (apiKeys && Array.isArray(apiKeys) && apiKeys.length > 0) {
      keys = apiKeys.filter(k => k && k.trim());
    } else if (apiKey) {
      keys = [apiKey];
    }

    if (keys.length === 0) {
      res.status(400).json({
        error: 'No AI provider available. Pollinations failed and no Gemini API key is configured.'
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
      error: 'All API keys rate limited or invalid.',
      details: lastError?.message
    });

  } catch (error) {
    console.error('Handler error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

function convertGeminiToOpenAI(contents) {
  if (!contents || !Array.isArray(contents)) return [];
  return contents.map(item => {
    let role = item.role === 'model' ? 'assistant' : item.role;
    if (role === 'user' && item.parts?.[0]?.text?.includes('You are MediAI Pro')) {
      role = 'system';
    }
    return {
      role: role,
      content: item.parts && item.parts[0] ? (item.parts[0].text || '') : ''
    };
  });
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
  if (deprecated[model]) return deprecated[model];
  return model || 'gemini-2.5-flash';
}
