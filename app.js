/* Genesys Cloud Transcript & AI Summary Widget — app.js (flat structure, GitHub Pages friendly) */
"use strict";

/* ---------------- state & settings ---------------- */
const LS = "gcTranscriptWidget";
const defaults = {
  region: "mypurecloud.de",
  clientId: "",
  uiLang: "da",
  sumLang: "da",
  provider: "openai",
  keyOpenai: "", modelOpenai: "gpt-4o-mini",
  keyGemini: "", modelGemini: "gemini-2.0-flash",
  keyClaude: "", modelClaude: "claude-sonnet-4-5",
  ollamaUrl: "http://localhost:11434", modelOllama: "llama3.1",
  proxyUrl: "",
  gcActionId: "",
  autoStart: true,
  focusPoints: ""
};
let cfg = { ...defaults, ...(JSON.parse(localStorage.getItem(LS) || "{}")) };

let token = sessionStorage.getItem("gcToken") || "";
let conversationId = "";
let ws = null, channelId = "", liveActive = false;
let utterances = new Map();   // utteranceId -> {who, offsetMs, text, isFinal}
let fetchedPhrases = [];      // from transcripturl: [{who, offsetMs, text}]
let T = I18N[cfg.uiLang] || I18N.da;

const $ = id => document.getElementById(id);
const api = path => `https://api.${cfg.region}${path}`;

/* ---------------- i18n rendering ---------------- */
function applyLang() {
  T = I18N[cfg.uiLang] || I18N.da;
  document.documentElement.lang = cfg.uiLang;
  $("t-title").textContent = T.title;
  $("nav-transcript").textContent = T.tabT;
  $("nav-summary").textContent = T.tabS;
  $("nav-settings").textContent = T.tabC;
  $("btnLive").textContent = liveActive ? T.liveStop : T.live;
  $("btnFetch").textContent = T.fetch;
  $("btnCopyT").textContent = T.copyT;
  $("btnClear").textContent = T.clear;
  $("t-hint-transcript").textContent = T.hintT;
  $("t-empty").textContent = T.empty;
  $("t-lbl-focus").textContent = T.lblFocus;
  $("focusPoints").placeholder = T.focusPh;
  $("t-lbl-provider").textContent = T.lblProvider;
  $("btnSummarize").textContent = T.summarize;
  $("btnCopyS").textContent = T.copyS;
  $("summaryOut").setAttribute("data-empty", T.sumEmpty);
  $("t-leg-genesys").textContent = T.legGenesys;
  $("t-lbl-region").textContent = T.lblRegion;
  $("t-lbl-clientid").textContent = T.lblClientId;
  $("t-lbl-convid").textContent = T.lblConvId;
  $("btnLogin").textContent = T.login;
  $("btnLogout").textContent = T.logout;
  $("btnSave").textContent = T.save;
  $("t-hint-keys").textContent = T.hintKeys;
  $("t-lbl-proxy").textContent = T.lblProxy;
  $("t-hint-proxy").textContent = T.hintProxy;
  $("t-lbl-action").textContent = T.lblAction;
  $("t-hint-action").textContent = T.hintAction;
  $("t-lbl-autostart").textContent = T.lblAutoStart;
  $("t-lbl-ollama").textContent = T.lblOllama;
  $("t-hint-ollama").textContent = T.hintOllama;
  $("btnCompare").textContent = T.compare;
  $("t-leg-ui").textContent = T.legUI;
  $("t-lbl-uilang").textContent = T.lblUiLang;
  $("authPill").textContent = token ? T.authOk : T.authNo;
  $("authPill").className = "pill " + (token ? "auth-ok" : "auth-no");
}

function msg(kind, text, sticky) {
  const el = $("msg");
  el.className = "msgbar show " + kind;
  el.textContent = text;
  clearTimeout(el._t);
  if (!sticky) el._t = setTimeout(() => { el.className = "msgbar"; }, 6000);
}

/* ---------------- tabs ---------------- */
document.querySelectorAll("nav button").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll("nav button").forEach(x => x.classList.remove("active"));
  document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  $("tab-" + b.dataset.tab).classList.add("active");
}));

/* ---------------- OAuth (Implicit Grant, public client) ---------------- */
function login() {
  saveForm();
  if (!cfg.clientId) { msg("err", T.errGeneric + "OAuth Client ID?"); return; }
  // preserve context across the redirect
  sessionStorage.setItem("gcCtx", JSON.stringify({ conversationId }));
  const redirect = location.origin + location.pathname;
  location.href = `https://login.${cfg.region}/oauth/authorize`
    + `?response_type=token&client_id=${encodeURIComponent(cfg.clientId)}`
    + `&redirect_uri=${encodeURIComponent(redirect)}`;
}

function handleAuthReturn() {
  if (location.hash.includes("access_token=")) {
    const p = new URLSearchParams(location.hash.substring(1));
    token = p.get("access_token") || "";
    if (token) sessionStorage.setItem("gcToken", token);
    history.replaceState(null, "", location.pathname + location.search);
    const ctx = JSON.parse(sessionStorage.getItem("gcCtx") || "{}");
    if (!conversationId && ctx.conversationId) conversationId = ctx.conversationId;
  }
}

function logout() {
  token = "";
  sessionStorage.removeItem("gcToken");
  stopLive(true);
  applyLang();
}

async function gc(path, opts = {}) {
  const r = await fetch(api(path), {
    ...opts,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...(opts.headers || {}) }
  });
  if (r.status === 401) { token = ""; sessionStorage.removeItem("gcToken"); applyLang(); throw new Error(T.needAuth); }
  if (!r.ok) throw new Error(`Genesys ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json();
}

/* ---------------- realtime transcription (Notifications API) ---------------- */
async function startLive(auto) {
  if (liveActive) return;
  if (!token) { if (!auto) msg("warn", T.needAuth); return; }
  if (!conversationId) { if (!auto) msg("warn", T.needConv); return; }
  const ch = await gc("/api/v2/notifications/channels", { method: "POST" });
  channelId = ch.id;
  await gc(`/api/v2/notifications/channels/${channelId}/subscriptions`, {
    method: "PUT",
    body: JSON.stringify([{ id: `v2.conversations.${conversationId}.transcription` }])
  });
  ws = new WebSocket(ch.connectUri);
  ws.onmessage = ev => {
    let d; try { d = JSON.parse(ev.data); } catch { return; }
    if (!d.topicName || !d.topicName.endsWith(".transcription")) return;
    const body = d.eventBody || {};
    if (body.status && body.status.status === "SESSION_ENDED") {
      msg("info", T.liveEnded, true);
      stopLive(true);
      return;
    }
    (body.transcripts || []).forEach(t => {
      const alt = (t.alternatives || [])[0];
      if (!alt || !alt.transcript) return;
      const who = (t.channel === "EXTERNAL") ? "customer" : "agent";
      utterances.set(t.utteranceId || (who + alt.offsetMs), {
        who, offsetMs: alt.offsetMs || 0, text: alt.transcript, isFinal: t.isFinal !== false
      });
    });
    renderStream();
  };
  ws.onclose = () => { if (liveActive) stopLive(true); };
  liveActive = true;
  $("livePill").hidden = false; $("livePill").className = "pill live"; $("livePill").textContent = "LIVE";
  applyLang();
  msg("info", auto ? T.liveAuto : T.liveOn);
}

function stopLive(silent) {
  liveActive = false;
  if (ws) { try { ws.close(); } catch (e) {} ws = null; }
  if (channelId && token) {
    fetch(api(`/api/v2/notifications/channels/${channelId}/subscriptions`), {
      method: "DELETE", headers: { Authorization: "Bearer " + token }
    }).catch(() => {});
    channelId = "";
  }
  $("livePill").hidden = true;
  applyLang();
  if (!silent) msg("info", T.liveOff);
}

/* ---------------- fetch transcript (Speech & Text Analytics) ---------------- */
async function fetchTranscript() {
  if (!token) { msg("warn", T.needAuth); return; }
  if (!conversationId) { msg("warn", T.needConv); return; }
  msg("info", T.fetching, true);
  try {
    const conv = await gc(`/api/v2/conversations/${conversationId}`);
    // collect candidate communicationIds (call sessions), customer first
    const comms = [];
    (conv.participants || [])
      .sort((a, b) => (a.purpose === "customer" || a.purpose === "external" ? -1 : 1))
      .forEach(p => (p.calls || p.sessions || []).forEach(c => c.id && comms.push(c.id)));
    let data = null;
    for (const commId of comms) {
      try {
        const u = await gc(`/api/v2/speechandtextanalytics/conversations/${conversationId}/communications/${commId}/transcripturl`);
        if (u && u.url) {
          const r = await fetch(u.url);
          if (r.ok) { data = await r.json(); break; }
        }
      } catch (e) { /* try next communication */ }
    }
    if (!data) { msg("warn", T.fetchNone); return; }
    fetchedPhrases = [];
    (data.transcripts || []).forEach(tr => (tr.phrases || []).forEach(ph => {
      const txt = ph.decoratedText || ph.text;
      if (!txt) return;
      const who = (ph.participantPurpose === "internal" || ph.participantPurpose === "agent") ? "agent" : "customer";
      fetchedPhrases.push({ who, offsetMs: ph.startTimeMs || 0, text: txt });
    }));
    renderStream();
    msg("info", `OK — ${fetchedPhrases.length} phrases.`);
  } catch (e) { msg("err", T.errGeneric + e.message, true); }
}

/* ---------------- transcript rendering / assembly ---------------- */
function currentTranscript() {
  const live = [...utterances.values()].sort((a, b) => a.offsetMs - b.offsetMs);
  const rows = fetchedPhrases.length >= live.length ? fetchedPhrases : live;
  return rows.map(r => ({ ...r }));
}

function mmss(ms) {
  const s = Math.floor(ms / 1000);
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

function renderStream() {
  const rows = currentTranscript();
  const el = $("stream");
  if (!rows.length) { el.innerHTML = `<div class="empty">${T.empty}</div>`; return; }
  el.innerHTML = rows.map(r =>
    `<div class="utt ${r.who}${r.isFinal === false ? " interim" : ""}">
       <div class="meta"><span>${r.who === "customer" ? T.customer : T.agent}</span><span>${mmss(r.offsetMs)}</span></div>
       <div>${escapeHtml(r.text)}</div>
     </div>`).join("");
  el.parentElement.scrollTop = el.parentElement.scrollHeight;
}

function transcriptAsText() {
  return currentTranscript()
    .map(r => `[${mmss(r.offsetMs)}] ${r.who === "customer" ? T.customer : T.agent}: ${r.text}`)
    .join("\n");
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------- AI summary ---------------- */
const SUM_LANG_NAME = { da: "Danish", en: "English", fr: "French", de: "German" };

function buildPrompt(transcript) {
  const focus = ($("focusPoints").value || "").trim();
  return [
    `You are an assistant for a contact center agent. Summarize the following customer call transcript.`,
    `Write the summary in ${SUM_LANG_NAME[$("sumLang").value] || "Danish"}.`,
    `Structure: 1) One-line reason for the call. 2) Key points as short bullets. 3) Agreements / next steps. 4) Open items or follow-ups.`,
    `Be concise and factual — the summary goes into wrap-up notes. Do not invent details.`,
    focus ? `Pay special attention to these focus points defined by the organisation:\n${focus}` : "",
    `\nTRANSCRIPT:\n${transcript}`
  ].filter(Boolean).join("\n");
}

/* Ollama has no key requirement — it counts as "available" when a URL is set.
   NOTE (browser mode): Ollama must allow the widget's origin:
   OLLAMA_ORIGINS="https://<user>.github.io" (or "*") before starting Ollama. */
function providerAvailable(p) {
  if (cfg.gcActionId || cfg.proxyUrl) return true;
  if (p === "ollama") return !!cfg.ollamaUrl;
  return !!cfg["key" + p[0].toUpperCase() + p.slice(1)];
}

async function callProvider(provider, prompt) {
  const t0 = performance.now();
  const key = provider === "ollama" ? "" : cfg["key" + provider[0].toUpperCase() + provider.slice(1)];
  let out = "";

  if (cfg.gcActionId) {
    /* Genesys Function Data Action mode: keys live ONLY in the Genesys
       integration's Credentials tab — nothing is sent from the browser.
       Executed with the agent's own Genesys token; requires the
       integrations:action:execute permission. */
    const d = await gc(`/api/v2/integrations/actions/${encodeURIComponent(cfg.gcActionId)}/execute`, {
      method: "POST",
      body: JSON.stringify({
        provider,
        model: cfg["model" + provider[0].toUpperCase() + provider.slice(1)] || "",
        prompt
      })
    });
    out = (d && d.text) || "";

  } else if (cfg.proxyUrl) {
    /* Proxy mode: server-side key/URL takes precedence; local values are fallback only. */
    const model = cfg["model" + provider[0].toUpperCase() + provider.slice(1)] || "";
    const r = await fetch(cfg.proxyUrl.replace(/\/$/, "") + "/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider, model, prompt,
        clientKey: key || undefined,
        ollamaUrl: provider === "ollama" ? (cfg.ollamaUrl || undefined) : undefined
      })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ("Proxy " + r.status));
    out = d.text || "";

  } else if (provider === "ollama") {
    const base = (cfg.ollamaUrl || "http://localhost:11434").replace(/\/$/, "");
    const r = await fetch(base + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.modelOllama || "llama3.1", stream: false, messages: [{ role: "user", content: prompt }] })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ("Ollama " + r.status));
    out = d.message?.content || "";

  } else if (provider === "openai") {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ model: cfg.modelOpenai || "gpt-4o-mini", messages: [{ role: "user", content: prompt }], max_tokens: 1000 })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || r.status);
    out = d.choices?.[0]?.message?.content || "";

  } else if (provider === "gemini") {
    const model = cfg.modelGemini || "gemini-2.0-flash";
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || r.status);
    out = d.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";

  } else { // claude
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({ model: cfg.modelClaude || "claude-sonnet-4-5", max_tokens: 1000, messages: [{ role: "user", content: prompt }] })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || r.status);
    out = (d.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
  }
  return { text: out.trim(), ms: Math.round(performance.now() - t0) };
}

const PROVIDER_NAME = { openai: "OpenAI", gemini: "Gemini", claude: "Claude", ollama: "Ollama" };

async function summarize() {
  const transcript = transcriptAsText();
  if (!transcript) { msg("warn", T.noTranscript); return; }
  const provider = $("provider").value;
  if (!providerAvailable(provider)) { msg("warn", T.needKey); return; }
  const btn = $("btnSummarize");
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span>${T.summarizing}`;
  try {
    const res = await callProvider(provider, buildPrompt(transcript));
    $("summaryOut").textContent = res.text;
    msg("info", `${PROVIDER_NAME[provider]} · ${(res.ms / 1000).toFixed(1)}s`);
  } catch (e) {
    msg("err", T.errGeneric + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = T.summarize;
  }
}

/* Run the same prompt on every available provider and show results
   side by side, with elapsed time — for quality/cost comparison. */
async function compareProviders() {
  const transcript = transcriptAsText();
  if (!transcript) { msg("warn", T.noTranscript); return; }
  const provs = ["openai", "gemini", "claude", "ollama"].filter(providerAvailable);
  if (!provs.length) { msg("warn", T.needKey); return; }
  const btn = $("btnCompare");
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span>${T.comparing}`;
  const prompt = buildPrompt(transcript);
  const outEl = $("summaryOut");
  outEl.textContent = "";
  const results = await Promise.allSettled(provs.map(p => callProvider(p, prompt)));
  outEl.textContent = results.map((r, i) => {
    const head = `━━━ ${PROVIDER_NAME[provs[i]]}` +
      (r.status === "fulfilled" ? ` · ${(r.value.ms / 1000).toFixed(1)}s` : "") + ` ━━━`;
    const body = r.status === "fulfilled" ? r.value.text : (T.errGeneric + r.reason.message);
    return head + "\n" + body;
  }).join("\n\n");
  btn.disabled = false;
  btn.textContent = T.compare;
}

/* ---------------- clipboard ---------------- */
async function copyText(text) {
  if (!text) return;
  try { await navigator.clipboard.writeText(text); msg("info", T.copied); }
  catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove(); msg("info", T.copied);
  }
}

/* ---------------- settings form ---------------- */
function loadForm() {
  $("region").value = cfg.region;
  $("clientId").value = cfg.clientId;
  $("uiLang").value = cfg.uiLang;
  $("sumLang").value = cfg.sumLang;
  $("provider").value = cfg.provider;
  $("keyOpenai").value = cfg.keyOpenai; $("modelOpenai").value = cfg.modelOpenai;
  $("keyGemini").value = cfg.keyGemini; $("modelGemini").value = cfg.modelGemini;
  $("keyClaude").value = cfg.keyClaude; $("modelClaude").value = cfg.modelClaude;
  $("ollamaUrl").value = cfg.ollamaUrl; $("modelOllama").value = cfg.modelOllama;
  $("proxyUrl").value = cfg.proxyUrl;
  $("gcActionId").value = cfg.gcActionId;
  $("autoStart").checked = !!cfg.autoStart;
  $("focusPoints").value = cfg.focusPoints;
  $("convId").value = conversationId;
}

function saveForm() {
  cfg.region = $("region").value;
  cfg.clientId = $("clientId").value.trim();
  cfg.uiLang = $("uiLang").value;
  cfg.sumLang = $("sumLang").value;
  cfg.provider = $("provider").value;
  cfg.keyOpenai = $("keyOpenai").value.trim(); cfg.modelOpenai = $("modelOpenai").value.trim() || defaults.modelOpenai;
  cfg.keyGemini = $("keyGemini").value.trim(); cfg.modelGemini = $("modelGemini").value.trim() || defaults.modelGemini;
  cfg.keyClaude = $("keyClaude").value.trim(); cfg.modelClaude = $("modelClaude").value.trim() || defaults.modelClaude;
  cfg.ollamaUrl = $("ollamaUrl").value.trim(); cfg.modelOllama = $("modelOllama").value.trim() || defaults.modelOllama;
  cfg.proxyUrl = $("proxyUrl").value.trim();
  cfg.gcActionId = $("gcActionId").value.trim();
  cfg.autoStart = $("autoStart").checked;
  cfg.focusPoints = $("focusPoints").value;
  if ($("convId").value.trim() && !$("convId").value.includes("{{")) conversationId = $("convId").value.trim();
  localStorage.setItem(LS, JSON.stringify(cfg));
}

/* ---------------- init ---------------- */
function init() {
  // URL params from Genesys Interaction Widget interpolation:
  // ?conversationId={{gcConversationId}}&langTag={{gcLangTag}}
  const q = new URLSearchParams(location.search);
  const cid = q.get("conversationId") || q.get("gcConversationId") || "";
  if (cid && !cid.includes("{{")) conversationId = cid;
  const lang = (q.get("langTag") || q.get("gcLangTag") || "").slice(0, 2).toLowerCase();
  if (lang && I18N[lang] && !localStorage.getItem(LS)) { cfg.uiLang = lang; cfg.sumLang = lang; }

  handleAuthReturn();
  loadForm();
  applyLang();
  renderStream();

  /* ---- fully automatic realtime mode ----
     If autoStart is on, the widget requires zero agent action:
     1) no token yet  -> silent SSO redirect to Genesys login (agent is
        already logged into Genesys, so it bounces straight back)
     2) token present -> subscribe to the transcription topic immediately */
  if (cfg.autoStart && conversationId) {
    if (!token && cfg.clientId && !sessionStorage.getItem("gcAuthTried")) {
      sessionStorage.setItem("gcAuthTried", "1"); // prevent redirect loops
      login();
      return;
    }
    if (token) {
      sessionStorage.removeItem("gcAuthTried");
      startLive(true).catch(e => msg("warn", T.errGeneric + e.message, true));
    }
  }

  $("btnLive").addEventListener("click", () => liveActive ? stopLive() : startLive().catch(e => msg("err", T.errGeneric + e.message, true)));
  $("btnFetch").addEventListener("click", fetchTranscript);
  $("btnCopyT").addEventListener("click", () => copyText(transcriptAsText()));
  $("btnClear").addEventListener("click", () => { utterances.clear(); fetchedPhrases = []; renderStream(); });
  $("btnSummarize").addEventListener("click", summarize);
  $("btnCompare").addEventListener("click", compareProviders);
  $("btnCopyS").addEventListener("click", () => copyText($("summaryOut").textContent));
  $("btnLogin").addEventListener("click", login);
  $("btnLogout").addEventListener("click", logout);
  $("btnSave").addEventListener("click", () => { saveForm(); applyLang(); msg("info", T.saved); });
  $("uiLang").addEventListener("change", () => { cfg.uiLang = $("uiLang").value; applyLang(); renderStream(); });
  $("focusPoints").addEventListener("change", () => { cfg.focusPoints = $("focusPoints").value; localStorage.setItem(LS, JSON.stringify(cfg)); });
  window.addEventListener("beforeunload", () => stopLive(true));
}

init();
