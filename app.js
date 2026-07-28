/* Genesys Cloud Transcript & AI Summary Widget — app.js (flat structure, GitHub Pages friendly) */
"use strict";

/* ---------------- state & settings ---------------- */
const LS = "gcTranscriptWidget";
const LOGLS = "gcTranscriptWidgetLog";
const defaults = {
  region: "mypurecloud.de",
  clientId: "",
  uiLang: "da",
  sumLang: "da",
  provider: "openai",
  keyOpenai: "", modelOpenai: "gpt-4o-mini",
  keyGemini: "", modelGemini: "gemini-2.0-flash",
  keyClaude: "", modelClaude: "claude-sonnet-4-5",
  keyAzure: "", azureEndpoint: "", azureDeployment: "", azureApiVersion: "2024-08-01-preview",
  ollamaUrl: "http://localhost:11434", modelOllama: "llama3.1",
  proxyUrl: "",
  whisperUrl: "", whisperCh0Role: "customer",
  gcActionId: "",
  autoStart: true,
  autoWrapup: false,
  autoWrapupCode: "",
  authType: "pkce",
  focusPoints: ""
};
let cfg = { ...defaults, ...(JSON.parse(localStorage.getItem(LS) || "{}")) };

let token = sessionStorage.getItem("gcToken") || "";
let conversationId = "";
let ws = null, channelId = "", liveActive = false, liveConvId = "";
let utterances = new Map();   // utteranceId -> {who, offsetMs, text, isFinal}
let fetchedPhrases = [];      // from transcripturl: [{who, offsetMs, text}]
let T = I18N[cfg.uiLang] || I18N.da;
let lastSummaryText = ""; // plain text mirror of #summaryOut, for the Copy button (HTML is rendered markdown)
let summarizing = false; // guards against manual + auto-wrapup firing concurrently (same transcript, duplicate AI call)
let lastSummarizedTranscript = ""; // transcript text the summary currently shown was generated from — used to disable the button once it's redundant

/* ---------------- generation statistics (for cost/time documentation) ----------------
   Every AI call (manual, auto, and each leg of Compare) is logged here as a
   structured record — provider, model, path, duration, success — separate
   from the free-text system log, so it can be exported as CSV and analysed
   (e.g. in Excel) to justify provider choice on cost vs. speed. Stored in
   localStorage like the debug log; same caveat: per-browser only, not
   centrally aggregated across agents. */
const STATSLS = "gcTranscriptWidgetStats";
let STATBUF = [];
try { STATBUF = JSON.parse(localStorage.getItem(STATSLS) || "[]"); } catch (e) { STATBUF = []; }
function recordStat(entry) {
  STATBUF.push({ ts: new Date().toISOString(), conversationId, ...entry });
  if (STATBUF.length > 1000) STATBUF.shift();
  try { localStorage.setItem(STATSLS, JSON.stringify(STATBUF)); } catch (e) { /* storage full — stats just stop growing */ }
}
function statsToCsv() {
  const header = ["timestamp", "conversationId", "trigger", "provider", "model", "via", "success", "ms", "seconds", "promptChars", "responseChars", "error"];
  const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = STATBUF.map(s => [
    s.ts, s.conversationId, s.trigger, s.provider, s.model, s.via, s.success,
    s.ms ?? "", s.ms != null ? (s.ms / 1000).toFixed(1) : "", s.promptChars ?? "", s.responseChars ?? "", s.error ?? ""
  ].map(esc).join(","));
  return [header.join(","), ...rows].join("\n");
}
function exportStatsCsv() {
  if (!STATBUF.length) { msg("warn", T.statsEmpty); return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([statsToCsv()], { type: "text/csv" }));
  a.download = "widget-stats-" + new Date().toISOString().slice(0, 10) + ".csv";
  a.click(); URL.revokeObjectURL(a.href);
}
function showStatsSummary() {
  if (!STATBUF.length) { msg("warn", T.statsEmpty); return; }
  const byKey = {};
  STATBUF.forEach(s => {
    if (!s.success) return;
    const key = `${s.provider}${s.model ? " (" + s.model + ")" : ""}`;
    (byKey[key] = byKey[key] || []).push(s.ms);
  });
  const lines = Object.entries(byKey).map(([k, arr]) => {
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    const min = Math.min(...arr), max = Math.max(...arr);
    return `${k}: n=${arr.length} · gns=${(avg / 1000).toFixed(1)}s · min=${(min / 1000).toFixed(1)}s · max=${(max / 1000).toFixed(1)}s`;
  });
  const failed = STATBUF.filter(s => !s.success).length;
  log("info", "Statistik-oversigt (" + STATBUF.length + " kald i alt):\n" + lines.join("\n") + (failed ? `\n${failed} fejlede kald` : ""));
  msg("info", T.statsShown);
}
function clearStats() {
  STATBUF = [];
  try { localStorage.removeItem(STATSLS); } catch (e) {}
  log("info", "Statistik ryddet.");
}

/* ---------------- system log ---------------- */
const LOGBUF = [];
/* Snapshot of the PREVIOUS session's log, captured once at load time —
   before this session's own log() calls start overwriting localStorage.
   Lets an agent recover what happened after the iframe was torn down
   (interaction closed / ACW timeout) before "Gem log" was clicked. */
let PREV_LOG = null;
try { PREV_LOG = JSON.parse(localStorage.getItem(LOGLS) || "null"); } catch (e) { PREV_LOG = null; }
function log(level, msg) {
  const ts = new Date().toISOString().substring(11, 23);
  LOGBUF.push({ ts, level, msg: String(msg) });
  if (LOGBUF.length > 500) LOGBUF.shift();
  const fn = level === "err" ? "error" : level === "warn" ? "warn" : "info";
  console[fn]("[widget " + ts + "]", msg);
  renderLog();
  persistLog();
  debugLogAppend(`${ts} [${level.toUpperCase()}] ${String(msg)}`);
}
/* Mirrors LOGBUF to localStorage on every entry, so the log survives the
   iframe being torn down before the agent had a chance to save it
   manually. Overwrites the same key each time — only the latest
   session's log is kept (capped at 500 lines, same as LOGBUF). */
function persistLog() {
  try {
    localStorage.setItem(LOGLS, JSON.stringify({ savedAt: new Date().toISOString(), conversationId, entries: LOGBUF }));
  } catch (e) { /* storage full/unavailable — in-memory log still works */ }
}
function renderLog() {
  const el = document.getElementById("logView");
  if (!el) return;
  el.innerHTML = LOGBUF.map(r =>
    `<div class="logrow ${r.level}"><span class="logts">${r.ts}</span><span>${r.msg.replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]))}</span></div>`
  ).join("");
  el.scrollTop = el.scrollHeight;
}
function logAsText() {
  return LOGBUF.map(r => `${r.ts} [${r.level.toUpperCase()}] ${r.msg}`).join("\n");
}

/* ---------------- debug mode: continuous file log (File System Access API) ----------------
   Chrome/Edge only. Writes+closes the file on EVERY log line (not buffered),
   so whatever happened is already on disk even if the iframe is torn down
   mid-call — unlike the in-memory LOGBUF or the localStorage mirror, which
   both die with the page. Requires one user click to grant file access;
   the handle is then cached in IndexedDB so a later reload (next call) can
   silently resume writing to the SAME file, if the browser still grants
   permission without re-prompting. May not work at all inside the Genesys
   widget iframe, depending on Genesys' embedding permissions-policy —
   untested against a live Interaction Widget frame. */
let debugFileHandle = null;
let debugWriteQueue = Promise.resolve();
const DEBUG_DB = "gcTranscriptWidgetDebug";
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DEBUG_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("handles");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSetHandle(handle) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("handles", "readwrite");
    tx.objectStore("handles").put(handle, "debugLogFile");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGetHandle() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("handles", "readonly");
    const req = tx.objectStore("handles").get("debugLogFile");
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
function renderDebugStatus() {
  setTxt("debugFileStatus", debugFileHandle ? (T.debugActive + ": " + debugFileHandle.name) : "");
  if ($("btnDebugStart")) $("btnDebugStart").hidden = !!debugFileHandle;
  if ($("btnDebugStop")) $("btnDebugStop").hidden = !debugFileHandle;
}
function debugLogAppend(line) {
  if (!debugFileHandle) return;
  debugWriteQueue = debugWriteQueue.then(async () => {
    try {
      const file = await debugFileHandle.getFile();
      const writable = await debugFileHandle.createWritable({ keepExistingData: true });
      await writable.write({ type: "write", position: file.size, data: line + "\n" });
      await writable.close();
    } catch (e) { console.error("Debug file-log write failed", e); }
  });
  return debugWriteQueue;
}
async function startDebugFileLog() {
  if (!debugFileLogAvailable()) { msg("warn", inIframe() ? T.debugBlockedIframe : T.debugUnsupported); return; }
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: "widget-debug-" + new Date().toISOString().slice(0, 10) + ".log",
      types: [{ description: "Log file", accept: { "text/plain": [".log", ".txt"] } }]
    });
    debugFileHandle = handle;
    idbSetHandle(handle).catch(() => {});
    renderDebugStatus();
    log("info", "Fil-log startet: " + handle.name);
  } catch (e) {
    if (e.name !== "AbortError") { log("err", "Kunne ikke starte fil-log: " + e.message); msg("err", T.errGeneric + e.message, true); }
  }
}
function stopDebugFileLog() {
  const name = debugFileHandle && debugFileHandle.name;
  debugFileHandle = null;
  renderDebugStatus();
  if (name) log("info", "Fil-log stoppet: " + name);
}
function inIframe() {
  try { return window.self !== window.top; } catch (e) { return true; }
}
function debugFileLogAvailable() {
  // Cross-origin sub-frames (which the Genesys widget iframe always is,
  // since it's served from a different origin than Genesys' own app) are
  // blocked by Chrome/Edge from showing the file picker at all — confirmed
  // in a live Interaction Widget: "Cross origin sub frames aren't allowed
  // to show a file picker." No workaround exists; the localStorage-based
  // "Hent forrige log" stays the working fallback inside the widget.
  return ("showSaveFilePicker" in window) && !inIframe();
}
async function tryResumeDebugFileLog() {
  if (!debugFileLogAvailable()) {
    setTxt("debugFileStatus", inIframe() ? T.debugBlockedIframe : T.debugUnsupported);
    if ($("btnDebugStart")) $("btnDebugStart").hidden = true;
    return;
  }
  try {
    const handle = await idbGetHandle();
    if (!handle) return;
    const perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm === "granted") {
      debugFileHandle = handle;
      renderDebugStatus();
      log("info", "Fil-log genoptaget automatisk: " + handle.name);
    } else if ($("btnDebugResume")) {
      $("btnDebugResume").hidden = false;
    }
  } catch (e) { /* no stored handle, or API restricted in this iframe context — ignore */ }
}
async function resumeDebugFileLogManual() {
  try {
    const handle = await idbGetHandle();
    if (!handle) return;
    const perm = await handle.requestPermission({ mode: "readwrite" });
    if (perm === "granted") {
      debugFileHandle = handle;
      renderDebugStatus();
      if ($("btnDebugResume")) $("btnDebugResume").hidden = true;
      log("info", "Fil-log genaktiveret: " + handle.name);
    }
  } catch (e) { log("err", "Kunne ikke genaktivere fil-log: " + e.message); }
}

const $ = id => document.getElementById(id);
const setTxt = (id, v) => { const e = $(id); if (e) e.textContent = v; };
const api = path => `https://api.${cfg.region}${path}`;

/* ---------------- i18n rendering ---------------- */
function applyLang() {
  T = I18N[cfg.uiLang] || I18N.da;
  document.documentElement.lang = cfg.uiLang;
  setTxt("t-title", T.title);
  setTxt("nav-transcript", T.tabT);
  setTxt("nav-summary", T.tabS);
  setTxt("nav-settings", T.tabC);
  setTxt("btnLive", liveActive ? T.liveStop : T.live);
  setTxt("btnFetch", T.fetch);
  setTxt("btnCopyT", T.copyT);
  setTxt("btnClear", T.clear);
  setTxt("t-hint-transcript", T.hintT);
  setTxt("t-empty", T.empty);
  setTxt("t-lbl-focus", T.lblFocus);
  if ($("focusPoints")) $("focusPoints").placeholder = T.focusPh;
  setTxt("t-lbl-provider", T.lblProvider);
  setTxt("btnSummarize", T.summarize);
  setTxt("btnCopyS", T.copyS);
  if ($("summaryOut")) $("summaryOut").setAttribute("data-empty", T.sumEmpty);
  setTxt("t-leg-genesys", T.legGenesys);
  setTxt("t-lbl-region", T.lblRegion);
  setTxt("t-lbl-clientid", T.lblClientId);
  setTxt("t-lbl-grant", T.lblGrant);
  setTxt("nav-log", T.tabLog);
  setTxt("btnLogCopy", T.copyT);
  setTxt("btnLogSave", T.logSave);
  setTxt("btnLogPrev", T.logPrev);
  setTxt("btnDebugStart", T.debugStart);
  setTxt("btnDebugStop", T.debugStop);
  setTxt("btnDebugResume", T.debugResume);
  setTxt("t-hint-debugfile", T.hintDebugFile);
  renderDebugStatus();
  setTxt("btnStatsShow", T.statsShow);
  setTxt("btnStatsExport", T.statsExport);
  setTxt("btnStatsClear", T.statsClear);
  setTxt("t-hint-stats", T.hintStats);
  setTxt("btnLogClear", T.clear);
  setTxt("t-lbl-convid", T.lblConvId);
  setTxt("btnLogin", T.login);
  setTxt("btnLogout", T.logout);
  setTxt("btnSave", T.save);
  setTxt("t-hint-keys", T.hintKeys);
  setTxt("t-hint-azure", T.hintAzure);
  setTxt("t-lbl-proxy", T.lblProxy);
  setTxt("t-hint-proxy", T.hintProxy);
  setTxt("t-lbl-action", T.lblAction);
  setTxt("t-hint-action", T.hintAction);
  setTxt("t-lbl-autostart", T.lblAutoStart);
  setTxt("t-lbl-autowrapup", T.lblAutoWrapup);
  setTxt("t-hint-autowrapup", T.hintAutoWrapup);
  setTxt("t-lbl-autowrapupcode", T.lblAutoWrapupCode);
  setTxt("btnListWrapupCodes", T.listWrapupCodes);
  setTxt("t-lbl-ollama", T.lblOllama);
  setTxt("t-leg-transcript", T.legTranscript);
  setTxt("t-lbl-whisper", T.lblWhisper);
  setTxt("t-hint-whisper", T.hintWhisper);
  setTxt("t-lbl-whisperch0", T.lblWhisperCh0);
  if ($("whisperCh0Role")) { $("whisperCh0Role").options[0].text = T.customer; $("whisperCh0Role").options[1].text = T.agent; }
  setTxt("t-hint-ollama", T.hintOllama);
  setTxt("btnCompare", T.compare);
  setTxt("t-leg-ui", T.legUI);
  setTxt("t-lbl-uilang", T.lblUiLang);
  setTxt("authPill", token ? T.authOk : T.authNo);
  if ($("authPill")) $("authPill").className = "pill " + (token ? "auth-ok" : "auth-no");
  if ($("authSettingsWrap")) $("authSettingsWrap").hidden = !!token;
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

/* ---------------- OAuth: PKCE (default) or Implicit ---------------- */
function redirectUri() {
  // must match the URI registered on the OAuth client EXACTLY.
  // Normalises .../index.html -> .../ so a trailing-slash registration works.
  return location.origin + location.pathname.replace(/index\.html$/, "");
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeState() {
  // context that must survive the OAuth redirect — returned verbatim by Genesys
  try { return btoa(JSON.stringify({ c: conversationId, l: cfg.uiLang })).replace(/=+$/, ""); }
  catch { return ""; }
}
function decodeState(s) {
  try { return JSON.parse(atob(s)); } catch { return {}; }
}

async function login() {
  saveForm();
  if (!cfg.clientId) { msg("err", T.errGeneric + "OAuth Client ID?"); log("err", "Login aborted: no Client ID"); return; }
  sessionStorage.setItem("gcCtx", JSON.stringify({ conversationId }));
  const redirect = redirectUri();
  const state = encodeState();
  const base = `https://login.${cfg.region}/oauth/authorize`;
  if (cfg.authType === "implicit") {
    log("info", `OAuth (implicit) → ${base} · clientId=${cfg.clientId} · redirect=${redirect}`);
    location.href = `${base}?response_type=token&client_id=${encodeURIComponent(cfg.clientId)}&redirect_uri=${encodeURIComponent(redirect)}&state=${encodeURIComponent(state)}`;
    return;
  }
  // PKCE: code verifier + S256 challenge
  const rnd = crypto.getRandomValues(new Uint8Array(32));
  const verifier = b64url(rnd);
  sessionStorage.setItem("gcVerifier", verifier);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = b64url(digest);
  log("info", `OAuth (PKCE) → ${base} · clientId=${cfg.clientId} · redirect=${redirect}`);
  location.href = `${base}?response_type=code&client_id=${encodeURIComponent(cfg.clientId)}`
    + `&redirect_uri=${encodeURIComponent(redirect)}`
    + `&state=${encodeURIComponent(state)}`
    + `&code_challenge=${challenge}&code_challenge_method=S256`;
}

async function handleAuthReturn() {
  const qs = new URLSearchParams(location.search);
  const hs = new URLSearchParams(location.hash.substring(1));
  const err = qs.get("error") || hs.get("error");
  if (err) {
    const desc = qs.get("error_description") || hs.get("error_description") || "";
    history.replaceState(null, "", location.pathname);
    log("err", `OAuth error from Genesys: ${err} ${desc}`);
    setTimeout(() => msg("err", T.errGeneric + "OAuth: " + err + (desc ? " — " + desc : "") + " · " + T.authHint, true), 0);
    return;
  }
  // Implicit return: #access_token=...
  if (location.hash.includes("access_token=")) {
    token = hs.get("access_token") || "";
    if (token) { sessionStorage.setItem("gcToken", token); log("info", "Implicit token received (" + token.slice(0, 8) + "…)"); }
    history.replaceState(null, "", location.pathname + location.search);
  }
  // PKCE return: ?code=...
  const code = qs.get("code");
  if (code) {
    log("info", "PKCE code received, exchanging for token…");
    const verifier = sessionStorage.getItem("gcVerifier") || "";
    try {
      const r = await fetch(`https://login.${cfg.region}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: cfg.clientId,
          redirect_uri: redirectUri(),
          code_verifier: verifier
        })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.access_token) {
        log("err", `Token exchange failed (${r.status}): ${JSON.stringify(d).slice(0, 300)}`);
        setTimeout(() => msg("err", T.errGeneric + "Token exchange " + r.status + " · " + T.authHint, true), 0);
      } else {
        token = d.access_token;
        sessionStorage.setItem("gcToken", token);
        log("info", `PKCE token received (${token.slice(0, 8)}…), expires_in=${d.expires_in}s`);
      }
    } catch (e) {
      log("err", "Token exchange error: " + e.message);
      setTimeout(() => msg("err", T.errGeneric + e.message, true), 0);
    }
    history.replaceState(null, "", location.pathname);
  }
  // restore context: OAuth state param (survives redirect guaranteed) -> gcCtx fallback
  const st = qs.get("state") || hs.get("state");
  if (st) {
    const ctx = decodeState(st);
    if (!conversationId && ctx.c) { conversationId = ctx.c; log("info", "conversationId restored from OAuth state: " + ctx.c); }
  }
  const ctx2 = JSON.parse(sessionStorage.getItem("gcCtx") || "{}");
  if (!conversationId && ctx2.conversationId) { conversationId = ctx2.conversationId; log("info", "conversationId restored from sessionStorage: " + ctx2.conversationId); }
}

function logout() {
  token = "";
  sessionStorage.removeItem("gcToken");
  stopLive(true);
  applyLang();
}

async function gc(path, opts = {}) {
  log("info", `${(opts.method || "GET")} ${path}`);
  const r = await fetch(api(path), {
    ...opts,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...(opts.headers || {}) }
  });
  if (r.status === 401) { token = ""; sessionStorage.removeItem("gcToken"); applyLang(); log("err", `401 on ${path} — token expired`); throw new Error(T.needAuth); }
  if (!r.ok) { const t = (await r.text()).slice(0, 300); log("err", `Genesys ${r.status} on ${path}: ${t}`); throw new Error(`Genesys ${r.status}: ${t}`); }
  log("info", `← ${r.status} ${path}`);
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
  log("info", "Notification channel created: " + channelId);
  ws = new WebSocket(ch.connectUri);
  ws.onopen = () => log("info", "WebSocket open — subscribed to v2.conversations." + conversationId + ".transcription");
  ws.onmessage = ev => {
    let d; try { d = JSON.parse(ev.data); } catch { return; }
    if (!d.topicName || !d.topicName.endsWith(".transcription")) return;
    const body = d.eventBody || {};
    if (body.status && body.status.status === "SESSION_ENDED") {
      log("info", "SESSION_ENDED received — transcription session over");
      msg("info", T.liveEnded, true);
      stopLive(true);
      if (cfg.autoWrapup) autoSummarizeAndWrapup();
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
  ws.onclose = e => { log("warn", "WebSocket closed (code " + e.code + ")"); if (liveActive) stopLive(true); };
  liveActive = true;
  liveConvId = conversationId;
  $("livePill").hidden = false; $("livePill").className = "pill live"; $("livePill").textContent = "LIVE";
  applyLang();
  msg("info", auto ? T.liveAuto : T.liveOn);
}

function stopLive(silent) {
  liveActive = false;
  liveConvId = "";
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
  if (cfg.whisperUrl) { return fetchTranscriptWhisper(); }
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
    log("info", `Transcript fetched: ${fetchedPhrases.length} phrases`);
    msg("info", `OK — ${fetchedPhrases.length} phrases.`);
  } catch (e) { msg("err", T.errGeneric + e.message, true); }
}

/* ---------------- fetch transcript via local Whisper (alternative to Genesys transcripturl) ----------------
   Downloads the call recording via the Genesys recording API and sends
   each audio channel to a locally-running whisper.cpp-based server.
   Contract expected from the local server:
     POST {whisperUrl}/transcribe   (multipart/form-data: channel<N> files, conversationId)
     -> { "utterances": [{ "channel": 0|1, "offsetMs": number, "text": string }, ...] }
   Genesys does not guarantee which channel is customer vs. agent, so the
   mapping is configurable under Opsætning ("Kanal 0 er"). */
function whisperRoleForChannel(ch) {
  const zeroIsCustomer = cfg.whisperCh0Role !== "agent";
  const isCh0 = Number(ch) === 0;
  return isCh0 === zeroIsCustomer ? "customer" : "agent";
}
async function fetchTranscriptWhisper() {
  msg("info", T.fetching, true);
  log("info", "Henter transskription via lokal Whisper: " + cfg.whisperUrl);
  try {
    const recs = await gc(`/api/v2/conversations/${conversationId}/recordings?formatId=WAV&maxWaitMs=20000`);
    if (!Array.isArray(recs) || !recs.length) { msg("warn", T.fetchNone); return; }
    const channels = [];
    recs.forEach(rec => {
      const uris = rec.mediaUris || {};
      Object.keys(uris).forEach(ch => { if (uris[ch] && uris[ch].mediaUri) channels.push({ ch: Number(ch) || 0, uri: uris[ch].mediaUri }); });
    });
    if (!channels.length) { msg("warn", T.fetchNone); return; }
    log("info", `Downloading ${channels.length} audio channel(s) for Whisper`);
    const blobs = await Promise.all(channels.map(c => fetch(c.uri).then(r => { if (!r.ok) throw new Error("Recording download " + r.status); return r.blob(); })));
    const fd = new FormData();
    channels.forEach((c, i) => fd.append("channel" + c.ch, blobs[i], `channel${c.ch}.wav`));
    fd.append("conversationId", conversationId);
    let r;
    try {
      r = await fetch(cfg.whisperUrl.replace(/\/$/, "") + "/transcribe", { method: "POST", body: fd });
    } catch (e) {
      throw new Error("Whisper-server ikke nået (" + e.message + ") — tjek URL, at serveren kører, og CORS.");
    }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ("Whisper " + r.status));
    fetchedPhrases = (d.utterances || [])
      .map(u => ({ who: whisperRoleForChannel(u.channel), offsetMs: u.offsetMs || 0, text: u.text || "" }))
      .filter(p => p.text);
    renderStream();
    log("info", `Whisper-transskription hentet: ${fetchedPhrases.length} fraser`);
    msg("info", `OK — ${fetchedPhrases.length} fraser (Whisper).`);
  } catch (e) {
    log("err", "Whisper fetch error: " + e.message);
    msg("err", T.errGeneric + e.message, true);
  }
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
  if (!rows.length) { el.innerHTML = `<div class="empty" id="t-empty">${T.empty}</div>`; return; }
  el.innerHTML = rows.map(r =>
    `<div class="utt ${r.who}${r.isFinal === false ? " interim" : ""}">
       <div class="meta"><span>${r.who === "customer" ? T.customer : T.agent}</span><span>${mmss(r.offsetMs)}</span></div>
       <div>${escapeHtml(r.text)}</div>
     </div>`).join("");
  el.parentElement.scrollTop = el.parentElement.scrollHeight;
  updateSummarizeAvailability();
}

/* Keeps "Generér resumé"/"Sammenlign udbydere" disabled unless there's
   actually something new to summarize — no transcript yet, or the
   transcript hasn't changed since the summary currently shown was made
   (e.g. right after auto-resumé already ran at SESSION_ENDED). Doesn't
   touch button state while a generation is already in progress. */
function updateSummarizeAvailability() {
  if (summarizing) return;
  const btn = $("btnSummarize"), cbtn = $("btnCompare");
  if (!btn || !cbtn) return;
  const transcript = transcriptAsText();
  const hasTranscript = !!transcript;
  const upToDate = hasTranscript && transcript === lastSummarizedTranscript;
  btn.disabled = !hasTranscript || upToDate;
  btn.title = !hasTranscript ? T.noTranscript : (upToDate ? T.alreadySummarized : "");
  cbtn.disabled = !hasTranscript;
}

function transcriptAsText() {
  return currentTranscript()
    .map(r => `[${mmss(r.offsetMs)}] ${r.who === "customer" ? T.customer : T.agent}: ${r.text}`)
    .join("\n");
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* Minimal markdown renderer for AI summary output — handles the subset
   models actually produce (bold, bullet/numbered lists, paragraphs).
   No external dependency, per project convention. Input is escaped
   first, so this is safe against HTML injection from the AI response. */
function mdToHtml(text) {
  const s = escapeHtml(text || "");
  const lines = s.split(/\r?\n/);
  let html = "", listType = null;
  const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };
  lines.forEach(raw => {
    const line = raw.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    const bullet = line.match(/^\s*[-*]\s+(.*)/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (bullet) {
      if (listType !== "ul") { closeList(); html += "<ul>"; listType = "ul"; }
      html += `<li>${bullet[1]}</li>`;
    } else if (numbered) {
      if (listType !== "ol") { closeList(); html += "<ol>"; listType = "ol"; }
      html += `<li>${numbered[1]}</li>`;
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      html += `<p>${line}</p>`;
    }
  });
  closeList();
  return html;
}

/* Plain-text version for the clipboard and for auto-wrap-up notes —
   Genesys' native Notes field does not render markdown, so leaving the
   ** markers in produces literal asterisks there. */
function stripMarkdown(text) {
  return (text || "").replace(/\*\*(.+?)\*\*/g, "$1");
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
  if (p === "azure") return !!(cfg.keyAzure && cfg.azureEndpoint && cfg.azureDeployment);
  return !!cfg["key" + p[0].toUpperCase() + p.slice(1)];
}

/* Model/deployment label shown in logs and the timing line. Azure has no
   separate "model" setting — the deployment name plays that role. */
function providerModelLabel(provider) {
  if (provider === "ollama") return cfg.modelOllama || defaults.modelOllama;
  if (provider === "azure") return cfg.azureDeployment || "";
  return cfg["model" + provider[0].toUpperCase() + provider.slice(1)] || defaults["model" + provider[0].toUpperCase() + provider.slice(1)] || "";
}

async function callProvider(provider, prompt) {
  const t0 = performance.now();
  const via = cfg.gcActionId ? "data-action" : cfg.proxyUrl ? "proxy" : "direct";
  const model = providerModelLabel(provider);
  log("info", `AI call: ${provider} via ${via}, model ${model}, prompt ${prompt.length} chars`);
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
        model,
        prompt,
        ...(provider === "azure" ? { azureEndpoint: cfg.azureEndpoint, azureApiVersion: cfg.azureApiVersion } : {})
      })
    });
    out = (d && d.text) || "";

  } else if (cfg.proxyUrl) {
    /* Proxy mode: server-side key/URL takes precedence; local values are fallback only. */
    const r = await fetch(cfg.proxyUrl.replace(/\/$/, "") + "/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider, model, prompt,
        clientKey: key || undefined,
        ollamaUrl: provider === "ollama" ? (cfg.ollamaUrl || undefined) : undefined,
        azureEndpoint: provider === "azure" ? (cfg.azureEndpoint || undefined) : undefined,
        azureApiVersion: provider === "azure" ? (cfg.azureApiVersion || undefined) : undefined
      })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ("Proxy " + r.status));
    out = d.text || "";

  } else if (provider === "ollama") {
    const base = (cfg.ollamaUrl || "http://localhost:11434").replace(/\/$/, "");
    let r;
    try {
      r = await fetch(base + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: cfg.modelOllama || "llama3.1", stream: false, messages: [{ role: "user", content: prompt }] })
      });
    } catch (e) {
      // network-level failure = Ollama not running, wrong URL, or CORS blocked
      throw new Error(T.ollamaCors + " (" + e.message + ")");
    }
    const d = await r.json().catch(() => ({}));
    if (r.status === 403) throw new Error(T.ollamaCors + " (403)");
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
    const modelG = cfg.modelGemini || "gemini-2.0-flash";
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelG}:generateContent?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || r.status);
    out = d.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";

  } else if (provider === "azure") {
    /* Azure OpenAI Service (the "Copilot" backend most orgs mean internally):
       api-key header (not Bearer), and the model is selected by the
       deployment name baked into the URL, not a body field. */
    const ep = (cfg.azureEndpoint || "").replace(/\/$/, "");
    const dep = cfg.azureDeployment || "";
    const ver = cfg.azureApiVersion || "2024-08-01-preview";
    const r = await fetch(`${ep}/openai/deployments/${encodeURIComponent(dep)}/chat/completions?api-version=${encodeURIComponent(ver)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": key },
      body: JSON.stringify({ messages: [{ role: "user", content: prompt }], max_tokens: 1000 })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || r.status);
    out = d.choices?.[0]?.message?.content || "";

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
  const ms = Math.round(performance.now() - t0);
  log("info", `AI response: ${provider}, model ${model}, ${out.length} chars, ${ms} ms`);
  return { text: out.trim(), ms };
}

const PROVIDER_NAME = { openai: "OpenAI", gemini: "Gemini", claude: "Claude", azure: "Azure OpenAI (Copilot)", ollama: "Ollama" };

async function summarize() {
  const transcript = transcriptAsText();
  if (!transcript) { msg("warn", T.noTranscript); return; }
  const provider = $("provider").value;
  if (!providerAvailable(provider)) { msg("warn", T.needKey); return; }
  if (summarizing) { msg("warn", T.alreadyGenerating, true); return; }
  summarizing = true;
  const btn = $("btnSummarize");
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span>${T.summarizing}`;
  $("btnCompare").disabled = true;
  setTxt("t-sum-timing", "");
  const promptText = buildPrompt(transcript);
  try {
    const res = await callProvider(provider, promptText);
    lastSummaryText = stripMarkdown(res.text);
    lastSummarizedTranscript = transcript;
    $("summaryOut").innerHTML = mdToHtml(res.text);
    const timing = `${PROVIDER_NAME[provider]} · model ${providerModelLabel(provider) || provider} · ${(res.ms / 1000).toFixed(1)}s`;
    setTxt("t-sum-timing", timing);
    msg("info", timing);
    recordStat({ trigger: "manual", provider, model: providerModelLabel(provider), via: (cfg.gcActionId ? "data-action" : cfg.proxyUrl ? "proxy" : "direct"), success: true, ms: res.ms, promptChars: promptText.length, responseChars: res.text.length });
  } catch (e) {
    log("err", `AI error (${provider}): ${e.message}`);
    msg("err", T.errGeneric + e.message, true);
    recordStat({ trigger: "manual", provider, model: providerModelLabel(provider), via: (cfg.gcActionId ? "data-action" : cfg.proxyUrl ? "proxy" : "direct"), success: false, error: e.message, promptChars: promptText.length });
  } finally {
    summarizing = false;
    btn.textContent = T.summarize;
    $("btnCompare").disabled = false;
    updateSummarizeAvailability();
  }
}

/* Run the same prompt on every available provider and show results
   side by side, with elapsed time — for quality/cost comparison. */
async function compareProviders() {
  const transcript = transcriptAsText();
  if (!transcript) { msg("warn", T.noTranscript); return; }
  const provs = ["openai", "gemini", "claude", "azure", "ollama"].filter(providerAvailable);
  if (!provs.length) { msg("warn", T.needKey); return; }
  if (summarizing) { msg("warn", T.alreadyGenerating, true); return; }
  summarizing = true;
  const btn = $("btnCompare");
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span>${T.comparing}`;
  $("btnSummarize").disabled = true;
  const prompt = buildPrompt(transcript);
  const outEl = $("summaryOut");
  outEl.textContent = "";
  const results = await Promise.allSettled(provs.map(p => callProvider(p, prompt)));
  results.forEach((r, i) => {
    const via = cfg.gcActionId ? "data-action" : cfg.proxyUrl ? "proxy" : "direct";
    if (r.status === "rejected") {
      log("err", `AI error (${provs[i]}): ${r.reason.message}`);
      recordStat({ trigger: "compare", provider: provs[i], model: providerModelLabel(provs[i]), via, success: false, error: r.reason.message, promptChars: prompt.length });
    } else {
      recordStat({ trigger: "compare", provider: provs[i], model: providerModelLabel(provs[i]), via, success: true, ms: r.value.ms, promptChars: prompt.length, responseChars: r.value.text.length });
    }
  });
  lastSummaryText = results.map((r, i) =>
    `${PROVIDER_NAME[provs[i]]}${r.status === "fulfilled" ? " (" + (r.value.ms / 1000).toFixed(1) + "s)" : ""}:\n${r.status === "fulfilled" ? stripMarkdown(r.value.text) : (T.errGeneric + r.reason.message)}`
  ).join("\n\n");
  outEl.innerHTML = results.map((r, i) => {
    const head = `<h4>${PROVIDER_NAME[provs[i]]}` +
      (r.status === "fulfilled" ? ` · ${(r.value.ms / 1000).toFixed(1)}s` : "") + `</h4>`;
    const body = r.status === "fulfilled" ? mdToHtml(r.value.text) : `<p>${escapeHtml(T.errGeneric + r.reason.message)}</p>`;
    return head + body;
  }).join("");
  lastSummarizedTranscript = transcript;
  setTxt("t-sum-timing", "");
  summarizing = false;
  btn.textContent = T.compare;
  $("btnSummarize").disabled = false;
  updateSummarizeAvailability();
}

/* ---------------- auto summary + auto wrap-up (opt-in) ----------------
   Triggered by SESSION_ENDED, i.e. the instant the call ends — well
   before the agent clicks Done — so the AI call gets the whole ACW
   window instead of only the last few seconds. If it finishes before
   the iframe is torn down (agent clicks Done / ACW timeout), the result
   is written straight into Genesys' own wrap-up notes via the
   Conversations API, using the agent's own token/permissions. This does
   NOT survive the widget actually being closed — that requires a
   server-side flow independent of the browser (see README). */
async function autoSummarizeAndWrapup() {
  if (summarizing) { log("warn", "Auto-resumé: der kører allerede en generering — springer over for at undgå en dublet."); return; }
  const transcript = transcriptAsText();
  if (!transcript) { log("warn", "Auto-resumé: intet transskript endnu, springer over."); return; }
  const provider = ($("provider") && $("provider").value) || cfg.provider;
  if (!providerAvailable(provider)) { log("warn", "Auto-resumé: ingen AI-udbyder konfigureret, springer over."); return; }
  summarizing = true;
  const btn = $("btnSummarize");
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span>${T.summarizing} (auto)`;
  $("btnCompare").disabled = true;
  const convIdAtStart = conversationId;
  log("info", "Auto-resumé startet ved SESSION_ENDED (afventer ikke agentens klik)…");
  const promptText = buildPrompt(transcript);
  try {
    const res = await callProvider(provider, promptText);
    lastSummaryText = stripMarkdown(res.text);
    lastSummarizedTranscript = transcript;
    $("summaryOut").innerHTML = mdToHtml(res.text);
    const timing = `${PROVIDER_NAME[provider]} · ${(res.ms / 1000).toFixed(1)}s (auto)`;
    setTxt("t-sum-timing", timing);
    log("info", `Auto-resumé færdigt (${timing})`);
    recordStat({ trigger: "auto", provider, model: providerModelLabel(provider), via: (cfg.gcActionId ? "data-action" : cfg.proxyUrl ? "proxy" : "direct"), success: true, ms: res.ms, promptChars: promptText.length, responseChars: res.text.length });
    if (convIdAtStart !== conversationId) {
      log("warn", "Auto-resumé: conversationId ændrede sig undervejs — springer wrap-up-indsættelse over for at undgå at skrive på forkert samtale.");
      return;
    }
    await writeWrapupNotes(convIdAtStart, stripMarkdown(res.text));
  } catch (e) {
    log("err", "Auto-resumé fejlede: " + e.message);
    recordStat({ trigger: "auto", provider, model: providerModelLabel(provider), via: (cfg.gcActionId ? "data-action" : cfg.proxyUrl ? "proxy" : "direct"), success: false, error: e.message, promptChars: promptText.length });
  } finally {
    summarizing = false;
    btn.textContent = T.summarize;
    $("btnCompare").disabled = false;
    updateSummarizeAvailability();
  }
}

async function writeWrapupNotes(convId, text) {
  if (!token) { log("warn", "Auto-resumé: ikke logget ind, kan ikke skrive wrap-up."); return; }
  try {
    const conv = await gc(`/api/v2/conversations/${convId}`);
    const me = (conv.participants || []).find(p => p.purpose === "agent");
    if (!me) { log("warn", "Auto-resumé: fandt ingen agent-deltager at skrive wrap-up på."); return; }
    const wrapup = { notes: text };
    if (cfg.autoWrapupCode) wrapup.code = cfg.autoWrapupCode;
    await gc(`/api/v2/conversations/calls/${convId}/participants/${me.id}`, {
      method: "PATCH",
      body: JSON.stringify({ wrapup })
    });
    log("info", "Resumé skrevet til wrap-up notes automatisk.");
    msg("info", "Resumé indsat automatisk i wrap-up.");
  } catch (e) {
    const needsCode = /wrapup\s*code.*required/i.test(e.message);
    log("err", "Kunne ikke skrive wrap-up notes: " + e.message +
      (needsCode
        ? " — jeres kø kræver en wrapup-kode ved siden af notes. Udfyld \"Wrap-up kode ID\" under Opsætning (brug \"Vis kode-liste i log\" for at finde ID'et)."
        : " — tjek Log-fanen for statuskoden."));
  }
}

async function listWrapupCodes() {
  if (!token) { msg("warn", T.needAuth); return; }
  try {
    const d = await gc("/api/v2/routing/wrapupcodes?pageSize=100");
    const codes = (d.entities || []).map(c => `${c.id}  ${c.name}`).join("\n");
    log("info", "Wrap-up koder (id — navn):\n" + (codes || "(ingen fundet)"));
    msg("info", "Wrap-up koder listet i Log-fanen.");
  } catch (e) { msg("err", T.errGeneric + e.message, true); }
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
  $("authType").value = cfg.authType;
  $("clientId").value = cfg.clientId;
  $("uiLang").value = cfg.uiLang;
  $("sumLang").value = cfg.sumLang;
  $("provider").value = cfg.provider;
  $("keyOpenai").value = cfg.keyOpenai; $("modelOpenai").value = cfg.modelOpenai;
  $("keyGemini").value = cfg.keyGemini; $("modelGemini").value = cfg.modelGemini;
  $("keyClaude").value = cfg.keyClaude; $("modelClaude").value = cfg.modelClaude;
  $("keyAzure").value = cfg.keyAzure; $("azureDeployment").value = cfg.azureDeployment;
  $("azureEndpoint").value = cfg.azureEndpoint; $("azureApiVersion").value = cfg.azureApiVersion;
  $("ollamaUrl").value = cfg.ollamaUrl; $("modelOllama").value = cfg.modelOllama;
  $("proxyUrl").value = cfg.proxyUrl;
  $("whisperUrl").value = cfg.whisperUrl;
  $("whisperCh0Role").value = cfg.whisperCh0Role;
  $("gcActionId").value = cfg.gcActionId;
  $("autoStart").checked = !!cfg.autoStart;
  $("autoWrapup").checked = !!cfg.autoWrapup;
  $("autoWrapupCode").value = cfg.autoWrapupCode;
  $("focusPoints").value = cfg.focusPoints;
  $("convId").value = conversationId;
}

function saveForm() {
  cfg.region = $("region").value;
  cfg.authType = $("authType").value;
  cfg.clientId = $("clientId").value.trim();
  cfg.uiLang = $("uiLang").value;
  cfg.sumLang = $("sumLang").value;
  cfg.provider = $("provider").value;
  cfg.keyOpenai = $("keyOpenai").value.trim(); cfg.modelOpenai = $("modelOpenai").value.trim() || defaults.modelOpenai;
  cfg.keyGemini = $("keyGemini").value.trim(); cfg.modelGemini = $("modelGemini").value.trim() || defaults.modelGemini;
  cfg.keyClaude = $("keyClaude").value.trim(); cfg.modelClaude = $("modelClaude").value.trim() || defaults.modelClaude;
  cfg.keyAzure = $("keyAzure").value.trim(); cfg.azureDeployment = $("azureDeployment").value.trim();
  cfg.azureEndpoint = $("azureEndpoint").value.trim(); cfg.azureApiVersion = $("azureApiVersion").value.trim() || defaults.azureApiVersion;
  cfg.ollamaUrl = $("ollamaUrl").value.trim(); cfg.modelOllama = $("modelOllama").value.trim() || defaults.modelOllama;
  cfg.proxyUrl = $("proxyUrl").value.trim();
  cfg.whisperUrl = $("whisperUrl").value.trim();
  cfg.whisperCh0Role = $("whisperCh0Role").value;
  cfg.gcActionId = $("gcActionId").value.trim();
  cfg.autoStart = $("autoStart").checked;
  cfg.autoWrapup = $("autoWrapup").checked;
  cfg.autoWrapupCode = $("autoWrapupCode").value.trim();
  cfg.focusPoints = $("focusPoints").value;
  if ($("convId").value.trim() && !$("convId").value.includes("{{")) conversationId = $("convId").value.trim();
  localStorage.setItem(LS, JSON.stringify(cfg));
}

/* ---------------- init ---------------- */
async function init() {
  // URL params from Genesys Interaction Widget interpolation:
  // ?conversationId={{gcConversationId}}&langTag={{gcLangTag}}
  const q = new URLSearchParams(location.search);
  const cid = q.get("conversationId") || q.get("gcConversationId") || q.get("pcConversationId") || "";
  // guard: accept only a real UUID — protects against misconfigured widget URLs
  if (cid && !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(cid)) {
    setTimeout(() => log("warn", "Ignoring invalid conversationId from URL (not a UUID): " + cid.slice(0, 60)), 0);
  } else if (cid) {
    conversationId = cid;
  }
  const lang = (q.get("langTag") || q.get("gcLangTag") || "").slice(0, 2).toLowerCase();
  if (lang && I18N[lang] && !localStorage.getItem(LS)) { cfg.uiLang = lang; cfg.sumLang = lang; }

  log("info", `Widget start v1.7.0 · region=${cfg.region} · authType=${cfg.authType} · conversationId=${conversationId || "(none)"}`);
  log("info", "URL query: " + (location.search || "(empty)"));
  await handleAuthReturn();
  loadForm();
  applyLang();
  renderStream();
  updateSummarizeAvailability();

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
  $("btnClear").addEventListener("click", () => { utterances.clear(); fetchedPhrases = []; lastSummarizedTranscript = ""; renderStream(); });
  $("btnSummarize").addEventListener("click", summarize);
  $("btnCompare").addEventListener("click", compareProviders);
  $("btnCopyS").addEventListener("click", () => copyText(lastSummaryText));
  $("btnLogin").addEventListener("click", login);
  $("btnLogout").addEventListener("click", logout);
  $("btnSave").addEventListener("click", () => {
    saveForm(); applyLang(); msg("info", T.saved);
    // conversationId changed while a live subscription is running (or none yet):
    // resubscribe automatically so the agent never has to stop/start manually
    if (conversationId && conversationId !== liveConvId) {
      log("info", "conversationId changed -> resubscribing (" + (liveConvId || "none") + " -> " + conversationId + ")");
      if (liveActive) stopLive(true);
      if (token) startLive(true).catch(e => msg("warn", T.errGeneric + e.message, true));
    }
  });
  $("uiLang").addEventListener("change", () => { cfg.uiLang = $("uiLang").value; applyLang(); renderStream(); });
  $("focusPoints").addEventListener("change", () => { cfg.focusPoints = $("focusPoints").value; localStorage.setItem(LS, JSON.stringify(cfg)); });
  $("btnLogCopy").addEventListener("click", () => copyText(logAsText()));
  $("btnLogClear").addEventListener("click", () => { LOGBUF.length = 0; renderLog(); persistLog(); });
  $("btnLogSave").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([logAsText()], { type: "text/plain" }));
    a.download = "widget-log-" + new Date().toISOString().replace(/[:.]/g, "-") + ".txt";
    a.click(); URL.revokeObjectURL(a.href);
  });
  if (PREV_LOG && Array.isArray(PREV_LOG.entries) && PREV_LOG.entries.length) {
    $("btnLogPrev").hidden = false;
    log("info", `Gemt log fra forrige session fundet (${PREV_LOG.savedAt}, conversationId=${PREV_LOG.conversationId || "(ukendt)"}) — se "${T.logPrev}" i Log-fanen.`);
  } else {
    $("btnLogPrev").hidden = true;
  }
  $("btnLogPrev").addEventListener("click", () => {
    if (!PREV_LOG) return;
    const header = `Gemt: ${PREV_LOG.savedAt} \u00b7 conversationId: ${PREV_LOG.conversationId || "(ukendt)"}\n\n`;
    const text = header + (PREV_LOG.entries || []).map(r => `${r.ts} [${r.level.toUpperCase()}] ${r.msg}`).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = "widget-log-forrige-" + (PREV_LOG.savedAt || "").replace(/[:.]/g, "-") + ".txt";
    a.click(); URL.revokeObjectURL(a.href);
  });
  $("btnListWrapupCodes").addEventListener("click", listWrapupCodes);
  $("btnStatsShow").addEventListener("click", showStatsSummary);
  $("btnStatsExport").addEventListener("click", exportStatsCsv);
  $("btnStatsClear").addEventListener("click", clearStats);
  $("btnDebugStart").addEventListener("click", startDebugFileLog);
  $("btnDebugStop").addEventListener("click", stopDebugFileLog);
  $("btnDebugResume").addEventListener("click", resumeDebugFileLogManual);
  await tryResumeDebugFileLog();
  window.addEventListener("beforeunload", () => stopLive(true));
}

init();
