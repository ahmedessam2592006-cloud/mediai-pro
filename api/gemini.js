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
    const { model, contents, generationConfig, apiKeys, apiKey } = req.body;

    // ===== TRY POLLINATIONS.AI FIRST (FREE, NO KEY) =====
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
        // Convert OpenAI format to Gemini format
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

    // ===== FALLBACK TO GEMINI =====
    let keys = [];
    if (apiKeys && Array.isArray(apiKeys) && apiKeys.length > 0) {
      keys = apiKeys.filter(k => k && k.trim());
    } else if (apiKey) {
      keys = [apiKey];
    }

    if (keys.length === 0) {
      res.status(400).json({ error: 'No AI provider available. Add a Gemini API key or try again later.' });
      return;
    }

    const modelName = model || 'gemini-2.5-flash';
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

          res.status(response.status).json(data);
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
      error: 'All API keys rate limited. Please add more API keys or wait a few minutes.',
      details: lastError?.message
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

function convertGeminiToOpenAI(contents) {
  return (contents || []).map(item => ({
    role: item.role === 'model' ? 'assistant' : item.role,
    content: item.parts && item.parts[0] ? item.parts[0].text : ''
  }));
}
