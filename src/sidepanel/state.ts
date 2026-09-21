import { sendToBackground } from "../shared/messages";
import type { CompiledProfile, KeyStatus, Match, ScanSummary, Settings, SpendRecord } from "../shared/types";

export interface PanelState {
  tabId: number | null;
  url: string;
  origin: string;
  matches: Match[];
  summary?: ScanSummary;
  profiles: CompiledProfile[];
  settings?: Settings;
  hasKey: boolean;
  keyStatus?: KeyStatus;
  spend?: SpendRecord;
  /** Per-profile threshold overrides used by the slider (re-filters without calling Jev). */
  thresholdOverride: Record<string, number>;
  pendingAsks: Array<{ profileId: string; profileName: string; origin: string; tabId: number }>;
}

export const state: PanelState = {
  tabId: null,
  url: "",
  origin: "",
  matches: [],
  profiles: [],
  hasKey: false,
  thresholdOverride: {},
  pendingAsks: [],
};

type Listener = () => void;
const listeners = new Set<Listener>();
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function notify(): void {
  for (const fn of listeners) fn();
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export async function refreshActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return;
  state.tabId = tab.id;
  state.url = tab.url ?? "";
  state.origin = originOf(state.url);
  await refreshPage();
}

export async function refreshPage(): Promise<void> {
  if (state.tabId == null) return;
  const res = await sendToBackground<{ url: string; matches: Match[]; summary?: ScanSummary }>({ type: "GET_PAGE", tabId: state.tabId }).catch(() => undefined);
  if (!res) return;
  if (res.url) {
    state.url = res.url;
    state.origin = originOf(res.url);
  }
  state.matches = res.matches ?? [];
  state.summary = res.summary;
  notify();
}

export async function refreshProfiles(): Promise<void> {
  const res = await sendToBackground<{ profiles: CompiledProfile[] }>({ type: "GET_PROFILES" }).catch(() => undefined);
  if (res) state.profiles = res.profiles;
  notify();
}

export async function refreshSettings(): Promise<void> {
  const res = await sendToBackground<{ settings: Settings; hasKey: boolean }>({ type: "GET_SETTINGS" }).catch(() => undefined);
  if (res) {
    state.settings = res.settings;
    state.hasKey = res.hasKey;
  }
  const spend = await sendToBackground<{ spend: SpendRecord }>({ type: "GET_SPEND" }).catch(() => undefined);
  if (spend) state.spend = spend.spend;
  notify();
}
