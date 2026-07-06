/**
 * AI Summary Proxy — Cloudflare Worker
 * ------------------------------------
 * Holds provider API keys as server-side secrets so agents never see them.
 *
 * KEY PRECEDENCE (as requested):
 *   1. If a server-side secret exists for the provider -> it is ALWAYS used.
 *      Any clientKey sent by the widget is ignored.
 *   2. If no server-side secret exists -> fall back to the clientKey from
 *      the widget (if provided). Otherwise 401.
 *
 * Deploy:
 *   npx wrangler deploy proxy-worker.js --name ai-summary-proxy
 *   npx wrangler secret put OPENAI_API_KEY
 *   npx wrangler secret put GEMINI_API_KEY
 *   npx wrangler secret put ANTHROPIC_API_KEY
 *   (only set the ones you want the proxy to own)
 *
 * Optional hardening (recommended for production):
 *   npx wrangler secret put ALLOWED_ORIGIN   e.g. https://skndkprivat.github.io
 *   npx wrangler secret put PROXY_TOKEN      shared token the widget must send
 *
 * Endpoint:
 *   POST /summarize
 *   { "provider": "openai"|"gemini"|"claude", "model": "...", "prompt": "...", "clientKey": "optional" }
 *   -> { "text": "...", "keySource": "server"|"client" }
 */

const DEFAULT_MODELS = {
  openai: "gpt-4o-mini",
  gemini: "gemini-2.0-flash",
  claude: "claude-sonnet-4-5",
  ollama: "llama3.1"
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "*";
    const allowOrigin = env.ALLOWED_ORIGIN || origin || "*";
    const cors = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Proxy-Token",
      "Vary": "Origin"
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "POST only" }, 405);

    const url = new URL(request.url);
    if (!url.pathname.endsWith("/summarize")) return json({ error: "Unknown endpoint. Use POST /summarize" }, 404);

    // Optional origin lock
    if (env.ALLOWED_ORIGIN && origin && origin !== env.ALLOWED_ORIGIN)
      return json({ error: "Origin not allowed" }, 403);

    // Optional shared token
    if (env.PROXY_TOKEN && request.headers.get("X-Proxy-Token") !== env.PROXY_TOKEN)
      return json({ error: "Invalid proxy token" }, 403);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

    const provider = (body.provider || "").toLowerCase();
    const prompt = body.prompt || "";
    const model = body.model || DEFAULT_MODELS[provider];
    if (!["openai", "gemini", "claude", "ollama"].includes(provider)) return json({ error: "Unknown provider: " + provider }, 400);
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
      claude: env.ANTHROPIC_API_KEY
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
