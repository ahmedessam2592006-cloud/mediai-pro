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

    // Support single key or multiple keys for rotation
    let keys = [];
    if (apiKeys && Array.isArray(apiKeys) && apiKeys.length > 0) {
      keys = apiKeys.filter(k => k && k.trim());
    } else if (apiKey) {
      keys = [apiKey];
    }

    if (keys.length === 0) {
      res.status(400).json({ error: 'API Key is required' });
      return;
    }

    const modelName = model || 'gemini-2.5-flash';

    // Simple in-memory cache (resets on serverless cold start, but helps with repeated requests)
    const cacheKey = JSON.stringify({ model: modelName, contents, generationConfig });

    // Try each key with exponential backoff
    const maxRetries = 3;
    const baseDelay = 2000; // 2 seconds

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

          // Check for rate limit
          if (response.status === 429) {
            const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
            console.log(`Rate limit hit for key ${keyIndex + 1}, attempt ${attempt + 1}/${maxRetries}. Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }

          // If successful or other error, return immediately
          res.status(response.status).json(data);
          return;

        } catch (fetchError) {
          lastError = fetchError;
          if (attempt < maxRetries - 1) {
            const delay = baseDelay * Math.pow(2, attempt);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }
    }

    // All keys exhausted
    res.status(429).json({ 
      error: 'All API keys rate limited. Please add more API keys or wait a few minutes.',
      details: lastError?.message 
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
