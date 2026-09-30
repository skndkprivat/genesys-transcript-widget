/**
 * AI Summary Proxy — Cloudflare Worker
 * ------------------------------------
 * Holds provider API keys as server-side secrets so agents never see them.
 *
 * AUTHENTICATION (v1.9.0, required):
 *   Every request must carry the agent's Genesys Cloud access token
 *   (Authorization: Bearer <token>) — the widget sends it automatically.
 *   The Worker validates it against GET /api/v2/tokens/me in GC_REGION and
 *   only serves tokens whose organization id equals GC_ORG_ID. Without this,
 *   anyone who knows the proxy URL (it is visible in the widget URL via
 *   orgProxyUrl) could spend the org's API keys. Fails closed: if GC_REGION
 *   or GC_ORG_ID is missing, every request is rejected.
 *
 * KEY PRECEDENCE:
 *   1. If a server-side secret exists for the provider -> it is ALWAYS used.
 *      Any clientKey sent by the widget is ignored.
 *   2. If no server-side secret exists -> fall back to the clientKey from
 *      the widget (if provided). Otherwise 401.
 *
 * Deploy:
 *   npx wrangler deploy proxy-worker.js --name ai-summary-proxy
 *   npx wrangler secret put GC_REGION          e.g. mypurecloud.de   (required)
 *   npx wrangler secret put GC_ORG_ID          your Genesys org id    (required)
 *   npx wrangler secret put OPENAI_API_KEY
 *   npx wrangler secret put GEMINI_API_KEY
 *   npx wrangler secret put ANTHROPIC_API_KEY
 *   npx wrangler secret put AZURE_OPENAI_KEY
 *   npx wrangler secret put AZURE_OPENAI_ENDPOINT      e.g. https://my-resource.openai.azure.com
 *   npx wrangler secret put AZURE_OPENAI_DEPLOYMENT    default deployment, e.g. gpt-4o
 *   npx wrangler secret put AZURE_OPENAI_API_VERSION   optional, default 2024-08-01-preview
 *   (only set the provider secrets you want the proxy to own)
 *
 * Optional:
 *   npx wrangler secret put ALLOWED_ORIGIN   e.g. https://skndkprivat.github.io
 *   (restricts browser CORS; NOT an access control — the token check is)
 *
 * Endpoint:
 *   POST /summarize   (Authorization: Bearer <Genesys token>)
 *   { "provider": "openai"|"gemini"|"claude"|"azure"|"ollama", "model": "...", "prompt": "...", "clientKey": "optional" }
 *   -> { "text": "...", "keySource": "server"|"client" }
 */

const DEFAULT_MODELS = {
  openai: "gpt-4o-mini",
  gemini: "gemini-2.0-flash",
  claude: "claude-sonnet-4-5",
  ollama: "llama3.1"
};
const PROVIDERS = ["openai", "gemini", "claude", "azure", "ollama"];

/* Validated-token cache (per Worker isolate), keyed by SHA-256 of the
   token so raw tokens are never kept in memory longer than the request. */
const TOKEN_CACHE = new Map();
const TOKEN_TTL_MS = 5 * 60 * 1000;

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/* Returns null if the token is valid for GC_ORG_ID, otherwise an error string. */
async function verifyGenesysToken(request, env) {
  if (!env.GC_REGION || !env.GC_ORG_ID) return "Proxy not configured: set GC_REGION and GC_ORG_ID secrets";
  if (!/^[a-z0-9.-]+$/i.test(env.GC_REGION)) return "Proxy misconfigured: invalid GC_REGION";
  const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+(\S+)$/i);
  if (!m) return "Missing Genesys token (Authorization: Bearer ...)";
  const token = m[1];
  const key = await sha256Hex(token);
  const now = Date.now();
  const hit = TOKEN_CACHE.get(key);
  if (hit && hit.exp > now) return null;

  let r;
  try {
    r = await fetch(`https://api.${env.GC_REGION}/api/v2/tokens/me`, { headers: { Authorization: "Bearer " + token } });
  } catch (e) {
    return "Could not verify Genesys token: " + e.message;
  }
  if (!r.ok) return "Invalid or expired Genesys token";
  const info = await r.json().catch(() => ({}));
  if (!info.organization || info.organization.id !== env.GC_ORG_ID) return "Token does not belong to the allowed Genesys organization";

  if (TOKEN_CACHE.size > 1000) TOKEN_CACHE.clear();
  TOKEN_CACHE.set(key, { exp: now + TOKEN_TTL_MS });
  return null;
}

/* Client-supplied Azure endpoints (only used together with a client key)
   must be real Azure OpenAI hosts, so the proxy can't be pointed elsewhere. */
function validAzureEndpoint(u) {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && /\.(openai\.azure\.com|cognitiveservices\.azure\.com)$/i.test(url.hostname);
  } catch { return false; }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      // Never reflect arbitrary origins; without ALLOWED_ORIGIN, "*" is safe
      // because access is gated by the Genesys token, not by cookies/origin.
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin"
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "POST only" }, 405);

    const url = new URL(request.url);
    if (!url.pathname.endsWith("/summarize")) return json({ error: "Unknown endpoint. Use POST /summarize" }, 404);

    // Optional origin lock (browser hygiene only — real access control is the token check below)
    if (env.ALLOWED_ORIGIN && origin && origin !== env.ALLOWED_ORIGIN)
      return json({ error: "Origin not allowed" }, 403);

    const authErr = await verifyGenesysToken(request, env);
    if (authErr) return json({ error: authErr }, authErr.startsWith("Proxy") ? 500 : 401);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

    const provider = (body.provider || "").toLowerCase();
    const prompt = body.prompt || "";
    const model = body.model || DEFAULT_MODELS[provider];
    if (!PROVIDERS.includes(provider)) return json({ error: "Unknown provider: " + provider }, 400);
    if (!prompt) return json({ error: "Missing prompt" }, 400);
    if (prompt.length > 200000) return json({ error: "Prompt too large" }, 413);

    /* ---- Ollama: no API key. Server-side OLLAMA_URL wins over the
       widget-provided ollamaUrl (same precedence rule as the keys).
       Note: the Ollama host must be reachable FROM the Worker, i.e. a
       server with a public/tunneled URL (cloudflared tunnel, Tailscale
       Funnel, on-prem reverse proxy) — not an agent's localhost. */
    if (provider === "ollama") {
      const base = (env.OLLAMA_URL || body.ollamaUrl || "").replace(/\/$/, "");
      if (!base) return json({ error: "No Ollama URL — set OLLAMA_URL in the proxy or an URL in the widget." }, 400);
      try {
        const r = await fetch(base + "/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: prompt }] })
        });
        const d = await r.json();
        if (!r.ok) return json({ error: d.error || ("Ollama " + r.status) }, r.status);
        return json({ text: (d.message?.content || "").trim(), keySource: env.OLLAMA_URL ? "server" : "client" });
      } catch (e) {
        return json({ error: "Ollama unreachable: " + e.message }, 502);
      }
    }

    // ---- key precedence: server secret wins, clientKey is fallback only ----
    const serverKey = {
      openai: env.OPENAI_API_KEY,
      gemini: env.GEMINI_API_KEY,
      claude: env.ANTHROPIC_API_KEY,
      azure: env.AZURE_OPENAI_KEY
    }[provider];
    const key = serverKey || body.clientKey;
    const keySource = serverKey ? "server" : "client";
    if (!key) return json({ error: `No API key for '${provider}' — set a secret in the proxy or a key in the widget.` }, 401);

    try {
      let text = "";

      if (provider === "openai") {
        const r = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 1000 })
        });
        const d = await r.json();
        if (!r.ok) return json({ error: d.error?.message || ("OpenAI " + r.status) }, r.status);
        text = d.choices?.[0]?.message?.content || "";

      } else if (provider === "gemini") {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
          }
        );
        const d = await r.json();
        if (!r.ok) return json({ error: d.error?.message || ("Gemini " + r.status) }, r.status);
        text = d.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";

      } else if (provider === "azure") {
        /* With the server key, ONLY the server endpoint is used — a
           client-chosen endpoint must never receive the org's key. */
        const endpoint = (serverKey ? env.AZURE_OPENAI_ENDPOINT : body.azureEndpoint) || "";
        const deployment = body.model || env.AZURE_OPENAI_DEPLOYMENT || "";
        const apiVersion = (serverKey ? env.AZURE_OPENAI_API_VERSION : body.azureApiVersion) || "2024-08-01-preview";
        if (!endpoint) return json({ error: "No Azure endpoint — set AZURE_OPENAI_ENDPOINT in the proxy." }, 400);
        if (!validAzureEndpoint(endpoint)) return json({ error: "Azure endpoint must be https://<resource>.openai.azure.com" }, 400);
        if (!/^[\w.-]+$/.test(deployment)) return json({ error: "Missing or invalid Azure deployment name" }, 400);
        const r = await fetch(`${endpoint.replace(/\/$/, "")}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "api-key": key },
          body: JSON.stringify({ messages: [{ role: "user", content: prompt }], max_tokens: 1000 })
        });
        const d = await r.json();
        if (!r.ok) return json({ error: d.error?.message || ("Azure " + r.status) }, r.status);
        text = d.choices?.[0]?.message?.content || "";

      } else { // claude
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model, max_tokens: 1000, messages: [{ role: "user", content: prompt }] })
        });
        const d = await r.json();
        if (!r.ok) return json({ error: d.error?.message || ("Anthropic " + r.status) }, r.status);
        text = (d.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
      }

      return json({ text: text.trim(), keySource });
    } catch (e) {
      return json({ error: "Upstream error: " + e.message }, 502);
    }
  }
};
