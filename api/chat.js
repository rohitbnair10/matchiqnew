// MatchIQ Chat Proxy — Vercel Serverless Function

const RATE_LIMIT = 100;
const RATE_WINDOW = 60 * 60 * 1000;
const rateLimitMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  if (!record || now - record.start > RATE_WINDOW) {
    rateLimitMap.set(ip, { start: now, count: 1 });
    return true;
  }
  if (record.count >= RATE_LIMIT) return false;
  record.count++;
  return true;
}

export default async function handler(req, res) {
  // CORS headers on every response
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Rate limit
  const ip = (req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: "Rate limited. Try again later." });
  }

  // Validate
  const { messages, max_tokens, temperature } = req.body || {};
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array required" });
  }

  // Check API key
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

  // Forward to OpenAI
  try {
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: messages,
        max_tokens: max_tokens || 2500,
        temperature: temperature ?? 0.85,
      }),
    });

    if (!openaiRes.ok) {
      const err = await openaiRes.json().catch(() => ({}));
      return res.status(openaiRes.status).json({
        error: err.error?.message || "OpenAI error",
      });
    }

    const data = await openaiRes.json();
    return res.status(200).json({
      content: data.choices[0].message.content,
    });
  } catch (e) {
    return res.status(502).json({ error: "Failed to reach AI service" });
  }
}
