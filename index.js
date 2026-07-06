/**
 * AI Summary — Genesys Cloud Function Data Action handler
 * --------------------------------------------------------
 * Runs INSIDE Genesys Cloud (managed AWS Lambda). API keys are injected
 * from the Function integration's Credentials tab via the Request Body
 * Template — they never leave Genesys and are never visible to agents.
 *
 * Credentials tab fields (add the ones you use):
 *   openaiKey, geminiKey, anthropicKey, ollamaUrl
 *
 * Request Body Template (Data Action config):
 * {
 *   "provider":     "${input.provider}",
 *   "model":        "${input.model}",
 *   "prompt":       "${input.prompt}",
 *   "openaiKey":    "${credentials.openaiKey}",
 *   "geminiKey":    "${credentials.geminiKey}",
 *   "anthropicKey": "${credentials.anthropicKey}",
 *   "ollamaUrl":    "${credentials.ollamaUrl}"
 * }
 *
 * Runtime: nodejs20.x — Handler: src/index.handler
 * Zip layout:  function-ai-summary.zip
 *                └── src/index.js   (this file)
 */

"use strict";

const DEFAULT_MODELS = {
  openai: "gpt-4o-mini",
  gemini: "gemini-2.0-flash",
  claude: "claude-sonnet-4-5",
  ollama: "llama3.1"
};

/* Parse the incoming event defensively — Genesys delivers the rendered
   request body, but the wrapping differs between runtime versions. */
function parseEvent(event) {
  if (!event) return {};
  if (typeof event === "string") { try { return JSON.parse(event); } catch { return {}; } }
  if (typeof event.rawRequest === "string") { try { return JSON.parse(event.rawRequest); } catch { return {}; } }
  if (typeof event.body === "string") { try { return JSON.parse(event.body); } catch { return {}; } }
  if (typeof event.body === "object" && event.body) return event.body;
  return event;
}

exports.handler = async (event) => {
  const body = parseEvent(event);
  const provider = (body.provider || "").toLowerCase();
  const prompt = body.prompt || "";
  const model = body.model || DEFAULT_MODELS[provider];

  if (!["openai", "gemini", "claude", "ollama"].includes(provider))
    throw new Error("Unknown provider: " + provider);
  if (!prompt) throw new Error("Missing prompt");

  let text = "";

  if (provider === "openai") {
    if (!body.openaiKey) throw new Error("No openaiKey credential configured");
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + body.openaiKey },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 1000 })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || ("OpenAI " + r.status));
    text = d.choices?.[0]?.message?.content || "";

  } else if (provider === "gemini") {
    if (!body.geminiKey) throw new Error("No geminiKey credential configured");
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(body.geminiKey)}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
    );
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || ("Gemini " + r.status));
    text = d.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";

  } else if (provider === "claude") {
    if (!body.anthropicKey) throw new Error("No anthropicKey credential configured");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": body.anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 1000, messages: [{ role: "user", content: prompt }] })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || ("Anthropic " + r.status));
    text = (d.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");

  } else { // ollama — must be reachable from Genesys Cloud (public/tunneled URL)
    const base = (body.ollamaUrl || "").replace(/\/$/, "");
    if (!base) throw new Error("No ollamaUrl credential configured");
    const r = await fetch(base + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: prompt }] })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ("Ollama " + r.status));
    text = d.message?.content || "";
  }

  return { text: text.trim(), provider, model };
};
