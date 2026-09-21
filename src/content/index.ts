import type { ActiveProfilesMsg, BackgroundToContent, ResultsMsg } from "../shared/messages";
import { sendToBackground } from "../shared/messages";
import type { CompiledProfile } from "../shared/types";
import { collectCandidates } from "./extractors";
import { cleanText } from "./dom";

const HIGHLIGHT_STYLE_ID = "page-extractor-style";
const DEBOUNCE_MS = 5000;

let lastScanAt = 0;
let scanTimer: number | undefined;

function ensureStyles(): void {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = `
    [data-geo-status="accepted"], [data-geo-status="confirmed"] { outline: 2px solid rgba(16, 185, 129, .85) !important; outline-offset: 2px; border-radius: 2px; }
    [data-geo-status="review"] { outline: 2px dashed rgba(245, 158, 11, .9) !important; outline-offset: 2px; border-radius: 2px; }
    [data-geo-flash] { animation: page-extractor-flash 1.2s ease-out 1; }
    @keyframes page-extractor-flash { 0% { background-color: rgba(59,130,246,.35); } 100% { background-color: transparent; } }
  `;
  document.documentElement.appendChild(style);
}

function pageSummary(): string {
  const title = document.title ?? "";
  const h1 = document.querySelector("h1, h2, [role='heading']");
  const heading = h1 ? cleanText(h1.textContent, 200) : "";
  const body = cleanText(document.body?.innerText ?? "", 500);
  return [title, heading, body].filter(Boolean).join("\n");
}

/**
 * Content scripts can't read response headers. The service worker observes Cache-Control via
 * webRequest where it has host permission; here we only honor the meta-tag equivalent.
 */
function noStore(): boolean {
  try {
    const meta = document.querySelector('meta[http-equiv="Cache-Control" i]') as HTMLMetaElement | null;
    return !!meta && /no-store/i.test(meta.content);
  } catch {
    return false;
  }
}

async function scan(explicitProfiles?: CompiledProfile[]): Promise<void> {
  if (!document.body) return;
  lastScanAt = Date.now();
  let profiles: CompiledProfile[];
  if (explicitProfiles) {
    profiles = explicitProfiles;
  } else {
    const res = await sendToBackground<ActiveProfilesMsg | undefined>({
      type: "GET_ACTIVE_PROFILES",
      url: location.href,
      title: document.title,
      summary: pageSummary(),
      noStore: noStore(),
    }).catch(() => undefined);
    if (!res || res.type !== "ACTIVE_PROFILES" || !res.profiles.length) return;
    profiles = res.profiles;
  }
  clearHighlights();
  const candidates = collectCandidates(profiles);
  if (!candidates.length) {
    await sendToBackground({ type: "CANDIDATES", url: location.href, title: document.title, lang: document.documentElement.lang || "en", candidates: [] }).catch(() => undefined);
    return;
  }
  ensureStyles();
  await sendToBackground({
    type: "CANDIDATES",
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang || navigator.language || "en",
    candidates,
  }).catch((err) => console.warn("[page-extractor] failed to send candidates", err));
}

function clearHighlights(): void {
  for (const el of Array.from(document.querySelectorAll("[data-geo-status]"))) el.removeAttribute("data-geo-status");
  for (const el of Array.from(document.querySelectorAll("[data-geo-id]"))) el.removeAttribute("data-geo-id");
  for (const el of Array.from(document.querySelectorAll("[data-geo-match]"))) el.removeAttribute("data-geo-match");
}

function applyResults(msg: ResultsMsg): void {
  if (msg.url !== location.href) return;
  ensureStyles();
  for (const m of msg.matches) {
    if (m.status === "rejected" || !m.domPath) continue;
    const el = safeQuery(m.domPath);
    if (!el) continue;
    el.setAttribute("data-geo-status", m.status);
    el.setAttribute("data-geo-match", m.id);
  }
}

function safeQuery(selector: string): Element | null {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

function focusMatch(matchId: string, domPath?: string): void {
  const el = document.querySelector(`[data-geo-match="${matchId}"]`) ?? (domPath ? safeQuery(domPath) : null);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.setAttribute("data-geo-flash", "1");
  window.setTimeout(() => el.removeAttribute("data-geo-flash"), 1300);
}

function requestScan(explicitProfiles?: CompiledProfile[]): void {
  const wait = Math.max(0, DEBOUNCE_MS - (Date.now() - lastScanAt));
  if (scanTimer) window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(() => void scan(explicitProfiles), explicitProfiles ? 0 : wait);
}

chrome.runtime.onMessage.addListener((raw: BackgroundToContent, _sender, sendResponse) => {
  switch (raw.type) {
    case "RESULTS":
      applyResults(raw);
      sendResponse({ ok: true });
      return false;
    case "FOCUS_MATCH":
      focusMatch(raw.matchId, raw.domPath);
      sendResponse({ ok: true });
      return false;
    case "RESCAN_CONTENT":
      lastScanAt = 0;
      requestScan(raw.profiles);
      sendResponse({ ok: true });
      return false;
    default:
      return false;
  }
});

// Re-scan on SPA navigations (history API) since content scripts persist across pushState.
let lastHref = location.href;
window.setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    requestScan();
  }
}, 1000);

void scan();
