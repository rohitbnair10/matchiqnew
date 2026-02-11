// MatchIQ Chat Proxy — Vercel Edge Function
// Forwards chat requests to OpenAI, keeps API key server-side
// Rate limited: 20 requests per IP per hour

const RATE_LIMIT = 20;          // requests per window
const RATE_WINDOW = 60 * 60;    // 1 hour in seconds

// In-memory rate limit store (resets on cold start — fine for moderate traffic)
// For production scale, use Vercel KV or Upstash Redis
const rateLimitMap = new Map();

function getRateLimitKey(req) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip")
    || "unknown";
}

function checkRateLimit(key) {
  const now = Date.now();
  const record = rateLimitMap.get(key);

  if (!record || now - record.windowStart > RATE_WINDOW * 1000) {
    rateLimitMap.set(key, { windowStart: now, count: 1 });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }

  if (record.count >= RATE_LIMIT) {
    const resetIn = Math.ceil((record.windowStart + RATE_WINDOW * 1000 - now) / 1000);
    return { allowed: false, remaining: 0, resetIn };
  }

  record.count++;
  return { allowed: true, remaining: RATE_LIMIT - record.count };
}

export default async function handler(req) {
  // CORS — allow from Property Finder and Chrome extensions
  const origin = req.headers.get("origin") || "";
  const allowedOrigins = [
    "https://www.propertyfinder.ae",
    "chrome-extension://",
  ];
  const isAllowed = allowedOrigins.some(o => origin.startsWith(o));

  const corsHeaders = {
    "Access-Control-Allow-Origin": isAllowed ? origin : "https://www.propertyfinder.ae",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };

  // Handle preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Rate limit check
  const clientKey = getRateLimitKey(req);
  const rateCheck = checkRateLimit(clientKey);

  if (!rateCheck.allowed) {
    return new Response(JSON.stringify({
      error: `Rate limited. Try again in ${rateCheck.resetIn}s.`,
      resetIn: rateCheck.resetIn,
    }), {
      status: 429,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Retry-After": String(rateCheck.resetIn),
      },
    });
  }

  // Parse request
  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Validate — only allow messages array
  if (!Array.isArray(body.messages)) {
    return new Response(JSON.stringify({ error: "messages array required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Forward to OpenAI
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) {
    return new Response(JSON.stringify({ error: "Server misconfigured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: body.model || "gpt-4o-mini",   // default to mini to save costs
        messages: body.messages,
        max_tokens: body.max_tokens || 1500,
        temperature: body.temperature ?? 0.85,
      }),
    });

    if (!openaiRes.ok) {
      const err = await openaiRes.json().catch(() => ({}));
      return new Response(JSON.stringify({
        error: err.error?.message || `OpenAI error: ${openaiRes.status}`,
      }), {
        status: openaiRes.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await openaiRes.json();

    return new Response(JSON.stringify({
      content: data.choices[0].message.content,
      remaining: rateCheck.remaining,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: "Failed to reach AI service" }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

export const config = {
  runtime: "edge",
};
