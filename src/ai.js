/**
 * AI-assisted help (OpenAI-compatible chat completions).
 * Configured through env:
 *   AI_API_URL   e.g. https://api.openai.com/v1  or  http://localhost:8080/v1
 *   AI_API_KEY   optional (only when the endpoint requires it)
 *   AI_MODEL     defaults to gpt-4o-mini
 */

export function aiConfigured() {
  return Boolean(process.env.AI_API_URL);
}

function endpoint() {
  const base = String(process.env.AI_API_URL).replace(/\/+$/, '');
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

export async function askAI({ system, user, maxTokens = 500, temperature = 0.3, timeoutMs = 25000 }) {
  if (!aiConfigured()) throw new Error('AI_API_URL is not set');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint(), {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.AI_API_KEY ? { Authorization: `Bearer ${process.env.AI_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'gpt-4o-mini',
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`AI ${res.status}: ${text.slice(0, 200)}`);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('AI response was not JSON');
    }
    const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text;
    if (!content) throw new Error('AI response was empty');
    return String(content).trim();
  } finally {
    clearTimeout(timer);
  }
}
