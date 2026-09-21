/**
 * In-memory ring buffers for debug reporting, mirrored into chrome.storage.session so a
 * service-worker restart doesn't lose the trail. Nothing here is required for extraction;
 * it exists so a user can hand over a complete picture of a failed scan.
 */
import type { JevCallTrace, LogEntry, ScanTrace } from "../shared/debug";

const MAX_LOG = 300;
const MAX_JEV_CALLS = 12;
const SESSION_KEY = "debug_state";

interface DebugState {
  log: LogEntry[];
  jevCalls: JevCallTrace[];
  /** Last completed scan trace per tab id. */
  scans: { [tabId: number]: ScanTrace };
}

const state: DebugState = { log: [], jevCalls: [], scans: {} };
let loaded = false;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const stored = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY] as DebugState | undefined;
    if (stored) {
      state.log = stored.log ?? [];
      state.jevCalls = stored.jevCalls ?? [];
      state.scans = stored.scans ?? {};
    }
  } catch {
    // session storage is unavailable in some contexts; debug data is then in-memory only
  }
}

function flush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void chrome.storage.session.set({ [SESSION_KEY]: state }).catch(() => undefined);
  }, 500);
}

export function logEvent(level: LogEntry["level"], where: string, message: string, detail?: unknown): void {
  const entry: LogEntry = { at: new Date().toISOString(), level, where, message };
  if (detail !== undefined) entry.detail = detail;
  state.log.push(entry);
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
  const line = `[page-extractor] ${where}: ${message}`;
  if (level === "error") console.error(line, detail ?? "");
  else if (level === "warn") console.warn(line, detail ?? "");
  else console.debug(line, detail ?? "");
  flush();
}

export function recordJevCall(call: JevCallTrace): void {
  state.jevCalls.push(call);
  if (state.jevCalls.length > MAX_JEV_CALLS) state.jevCalls.splice(0, state.jevCalls.length - MAX_JEV_CALLS);
  flush();
}

/** Jev calls made since a given timestamp, optionally for one page URL. */
export function jevCallsSince(sinceIso: string, pageUrl?: string): JevCallTrace[] {
  return state.jevCalls.filter((c) => c.at >= sinceIso && (!pageUrl || !c.pageUrl || c.pageUrl === pageUrl));
}

export function saveScanTrace(tabId: number, trace: ScanTrace): void {
  state.scans[tabId] = trace;
  flush();
}

export function getScanTrace(tabId: number): ScanTrace | undefined {
  return state.scans[tabId];
}

export function getLog(): LogEntry[] {
  return state.log.slice(-MAX_LOG);
}

export async function ready(): Promise<void> {
  await load();
}

export async function clearDebugState(): Promise<void> {
  state.log = [];
  state.jevCalls = [];
  state.scans = {};
  await chrome.storage.session.remove(SESSION_KEY).catch(() => undefined);
}
