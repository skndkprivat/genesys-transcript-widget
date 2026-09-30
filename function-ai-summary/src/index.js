/**
 * AI Summary — Genesys Cloud Function Data Action handler
 * --------------------------------------------------------
 * Runs INSIDE Genesys Cloud (managed AWS Lambda). API keys are injected
 * from the Function integration's Credentials tab via the Request Body
 * Template — they never leave Genesys and are never visible to agents.
 *
 * Credentials tab fields (add the ones you use):
 *   openaiKey, geminiKey, anthropicKey, ollamaUrl, ollamaModel,
 *   azureKey, azureEndpoint, azureDeployment, azureApiVersion,
 *   allowedModels
 *
 * allowedModels: comma-separated model/deployment names callers may
 * request (e.g. "gpt-4o-mini,gpt-4o"). Empty = only the default model per
 * provider (DEFAULT_MODELS below, azureDeployment, ollamaModel) — so anyone
 * with integrations:action:execute can't switch the org's keys to an
 * expensive model.
 *
 * Azure endpoint/API version come ONLY from credentials, never from the
 * caller — so the org's Azure key can't be sent to a caller-chosen host.
 * input.model selects the Azure deployment; empty = azureDeployment.
 *
 * Request Body Template (Data Action config) — see CONTRACTS.md. Input
 * strings MUST be wrapped in $esc.jsonString(), otherwise newlines/quotes
 * in the transcript produce invalid JSON.
 *
 * Runtime: nodejs22.x — Handler: src/index.handler
 * Zip layout:  function-ai-summary.zip
 *                └── src/index.js   (this file)
 */

"use strict";

const DEFAULT_MODELS = {
  openai: "gpt-4o-mini",
  gemini: "gemini-flash-latest",
  claude: "claude-sonnet-4-5",
  ollama: "llama3.1"
};
const PROVIDERS = ["openai", "gemini", "claude", "azure", "ollama"];
const MAX_PROMPT_CHARS = 120000; // ~1 hour of call transcript with headroom
const MAX_OUTPUT_TOKENS = 1000;

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

function defaultModel(provider, body) {
  if (provider === "azure") return body.azureDeployment || "";
  if (provider === "ollama") return body.ollamaModel || DEFAULT_MODELS.ollama;
  return DEFAULT_MODELS[provider];
}

/* A requested model is allowed if it is the provider default, or listed in
   the allowedModels credential. Empty request = default. */
function resolveModel(provider, body) {
  const def = defaultModel(provider, body);
  const model = String(body.model || def || "").trim();
  if (!model) throw new Error(`No model configured for '${provider}'`);
  if (!/^[\w.:-]+$/.test(model)) throw new Error("Invalid model name");
  const allowed = String(body.allowedModels || "").split(",").map(s => s.trim()).filter(Boolean);
  if (model !== def && !allowed.includes(model)) throw new Error(`Model '${model}' is not allowed (see allowedModels credential)`);
  return model;
}

exports.handler = async (event) => {
  const body = parseEvent(event);
  const provider = String(body.provider || "").toLowerCase();
  const prompt = typeof body.prompt === "string" ? body.prompt : "";

  if (!PROVIDERS.includes(provider)) throw new Error("Unknown provider: " + provider);
  if (!prompt) throw new Error("Missing prompt");
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`Prompt too large (max ${MAX_PROMPT_CHARS} chars)`);
  const model = resolveModel(provider, body);

  let text = "";

  if (provider === "openai") {
    if (!body.openaiKey) throw new Error("No openaiKey credential configured");
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + body.openaiKey },
      // max_completion_tokens works for both classic and reasoning (gpt-5/o-series) models;
      // reasoning models spend part of it on hidden reasoning, hence the headroom
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_completion_tokens: MAX_OUTPUT_TOKENS * 4 })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || ("OpenAI " + r.status));
    text = d.choices?.[0]?.message?.content || "";

  } else if (provider === "gemini") {
    if (!body.geminiKey) throw new Error("No geminiKey credential configured");
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": body.geminiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS } }) }
    );
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || ("Gemini " + r.status));
    text = d.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";

  } else if (provider === "azure") {
    if (!body.azureKey) throw new Error("No azureKey credential configured");
    const endpoint = (body.azureEndpoint || "").replace(/\/$/, "");
    if (!endpoint) throw new Error("No azureEndpoint credential configured");
    const apiVersion = body.azureApiVersion || "2024-08-01-preview";
    const r = await fetch(`${endpoint}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": body.azureKey },
      body: JSON.stringify({ messages: [{ role: "user", content: prompt }], max_tokens: MAX_OUTPUT_TOKENS })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || ("Azure " + r.status));
    text = d.choices?.[0]?.message?.content || "";

  } else if (provider === "claude") {
    if (!body.anthropicKey) throw new Error("No anthropicKey credential configured");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": body.anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: MAX_OUTPUT_TOKENS, messages: [{ role: "user", content: prompt }] })
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
