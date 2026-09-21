import type { ActiveProfilesMsg, BackgroundToContent, PageSourceReply, ResultsMsg } from "../shared/messages";
import { sendToBackground } from "../shared/messages";
import { BUILD_ID } from "../shared/debug";
import type { CollectionStats, CompiledProfile } from "../shared/types";
import { collectCandidates, getLastCollectionStats } from "./extractors";
import { cleanText } from "./dom";

const HIGHLIGHT_STYLE_ID = "page-extractor-style";
const DEBOUNCE_MS = 5000;

let lastScanAt = 0;
let scanTimer: number | undefined;

/** What the last scan did, surfaced in debug reports. */
interface ContentScanTrace {
  at: string;
  profilesReceived: number;
  profileNames: string[];
  candidates: number;
  stats: CollectionStats[];
  highlighted: number;
  skipped?: string;
  error?: string;
}
let lastTrace: ContentScanTrace | undefined;

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

async function scan(explicitProfiles?: CompiledProfile[], trigger: "page-load" | "rescan" | "test" = "page-load"): Promise<void> {
  if (!document.body) return;
  lastScanAt = Date.now();
  const trace: ContentScanTrace = { at: new Date().toISOString(), profilesReceived: 0, profileNames: [], candidates: 0, stats: [], highlighted: 0 };
  lastTrace = trace;
  let profiles: CompiledProfile[];
  try {
    if (explicitProfiles) {
      profiles = explicitProfiles;
    } else {
      const res = await sendToBackground<ActiveProfilesMsg | undefined>({
        type: "GET_ACTIVE_PROFILES",
        url: location.href,
        title: document.title,
        summary: pageSummary(),
        noStore: noStore(),
      }).catch((err) => {
        trace.error = `background did not answer: ${(err as Error).message}`;
        return undefined;
      });
      if (!res || res.type !== "ACTIVE_PROFILES") {
        trace.skipped = trace.error ?? "no reply from the service worker";
        return;
      }
      if (!res.profiles.length) {
        trace.skipped = res.skipped ?? "no active profiles for this URL";
        return;
      }
      profiles = res.profiles;
    }
    trace.profilesReceived = profiles.length;
    trace.profileNames = profiles.map((p) => p.name);
    clearHighlights();
    const candidates = collectCandidates(profiles);
    trace.candidates = candidates.length;
    trace.stats = getLastCollectionStats();
    if (!candidates.length) trace.skipped = "extractors produced no candidates";
    else ensureStyles();
    await sendToBackground({
      type: "CANDIDATES",
      url: location.href,
      title: document.title,
      lang: document.documentElement.lang || navigator.language || "en",
      candidates,
      stats: trace.stats,
      trigger,
    }).catch((err) => {
      trace.error = `failed to send candidates: ${(err as Error).message}`;
      console.warn("[page-extractor] failed to send candidates", err);
    });
  } catch (err) {
    trace.error = (err as Error).message;
    console.warn("[page-extractor] scan failed", err);
  }
}

// --- Page source capture for debug reports -------------------------------------------

/**
 * Inline script and style bodies are replaced with placeholders: they are large, can hold
 * credentials, and never affect extraction. JSON-LD is kept verbatim because the
 * structured_data extractor reads it.
 */
function filterSource(html: string): string {
  return html
    .replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, attrs: string, bodyText: string) => {
      if (/application\/ld\+json/i.test(attrs)) return full;
      const n = bodyText.length;
      return n > 0 ? `<script${attrs}>/* ${n} chars of inline script omitted */</script>` : full;
    })
    .replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (full, attrs: string, bodyText: string) => {
      const n = bodyText.length;
      return n > 200 ? `<style${attrs}>/* ${n} chars of CSS omitted */</style>` : full;
    })
    .replace(/(["'(])data:[^"')\s]{200,}/gi, (_m, q: string) => `${q}data:«long data URI omitted»`);
}

function capturePageSource(maxChars: number, raw: boolean): PageSourceReply {
  const original = document.documentElement.outerHTML;
  let html = raw ? original : filterSource(original);
  const filtered = !raw && html.length !== original.length;
  const truncated = html.length > maxChars;
  if (truncated) html = html.slice(0, maxChars);
  return {
    type: "PAGE_SOURCE",
    buildId: BUILD_ID,
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang || navigator.language || "",
    readyState: document.readyState,
    frameCount: window.frames.length,
    bytesOriginal: original.length,
    bytesIncluded: html.length,
    truncated,
    filtered,
    html,
    lastScan: lastTrace,
  };
}

function clearHighlights(): void {
  for (const el of Array.from(document.querySelectorAll("[data-geo-status]"))) el.removeAttribute("data-geo-status");
  for (const el of Array.from(document.querySelectorAll("[data-geo-id]"))) el.removeAttribute("data-geo-id");
  for (const el of Array.from(document.querySelectorAll("[data-geo-match]"))) el.removeAttribute("data-geo-match");
}

function applyResults(msg: ResultsMsg): void {
  if (msg.url !== location.href) return;
  ensureStyles();
  let highlighted = 0;
  for (const m of msg.matches) {
    if (m.status === "rejected" || !m.domPath) continue;
    const el = safeQuery(m.domPath);
    if (!el) continue;
    el.setAttribute("data-geo-status", m.status);
    el.setAttribute("data-geo-match", m.id);
    highlighted++;
  }
  if (lastTrace) lastTrace.highlighted = highlighted;
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

function requestScan(explicitProfiles?: CompiledProfile[], trigger: "page-load" | "rescan" | "test" = "page-load"): void {
  const wait = Math.max(0, DEBOUNCE_MS - (Date.now() - lastScanAt));
  if (scanTimer) window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(() => void scan(explicitProfiles, trigger), explicitProfiles ? 0 : wait);
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
      requestScan(raw.profiles, raw.profiles ? "test" : "rescan");
      sendResponse({ ok: true });
      return false;
    case "COLLECT_PAGE_SOURCE":
      try {
        sendResponse(capturePageSource(raw.maxChars, raw.raw));
      } catch (err) {
        sendResponse({ type: "ERROR", error: (err as Error).message });
      }
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
