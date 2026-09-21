import type { GeocodeResult, Settings, SpendRecord } from "../shared/types";

const KEYS = {
  apiKey: "openrouter_api_key",
  settings: "settings",
  spend: "spend",
  geocodeCache: "geocode_cache",
  docIndex: "doc_index",
  profilesDocId: "profiles_doc_id",
  askDecisions: "ask_decisions",
} as const;

export const DEFAULT_SETTINGS: Settings = {
  compilerModel: "openai/gpt-4.1-mini",
  geocoderProvider: "nominatim",
  onboarded: false,
};

async function get<T>(key: string): Promise<T | undefined> {
  const res = await chrome.storage.local.get(key);
  return res[key] as T | undefined;
}

async function set(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function getApiKey(): Promise<string | undefined> {
  return get<string>(KEYS.apiKey);
}

export async function setApiKey(key: string): Promise<void> {
  if (!key) await chrome.storage.local.remove(KEYS.apiKey);
  else await set(KEYS.apiKey, key);
}

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...((await get<Partial<Settings>>(KEYS.settings)) ?? {}) };
}

export async function patchSettings(patch: Partial<Settings> | Record<string, unknown>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch } as Settings;
  await set(KEYS.settings, next);
  return next;
}

// --- Spend meter ------------------------------------------------------------

const EMPTY_SPEND: SpendRecord = { totalCost: 0, totalTokens: 0, requests: 0, byPurpose: {} };

export async function getSpend(): Promise<SpendRecord> {
  return (await get<SpendRecord>(KEYS.spend)) ?? { ...EMPTY_SPEND, byPurpose: {} };
}

export async function recordSpend(purpose: string, cost: number | undefined, tokens: number | undefined): Promise<void> {
  const spend = await getSpend();
  const c = Number.isFinite(cost) ? (cost as number) : 0;
  const t = Number.isFinite(tokens) ? (tokens as number) : 0;
  spend.totalCost += c;
  spend.totalTokens += t;
  spend.requests += 1;
  const p = (spend.byPurpose[purpose] ??= { cost: 0, tokens: 0, requests: 0 });
  p.cost += c;
  p.tokens += t;
  p.requests += 1;
  await set(KEYS.spend, spend);
}

// --- Geocode cache (30 days) -----------------------------------------------

interface CacheEntry {
  result: GeocodeResult | null;
  storedAt: number;
}
const GEOCODE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function getCachedGeocode(normalizedQuery: string): Promise<GeocodeResult | null | undefined> {
  const cache = (await get<Record<string, CacheEntry>>(KEYS.geocodeCache)) ?? {};
  const entry = cache[normalizedQuery];
  if (!entry) return undefined;
  if (Date.now() - entry.storedAt > GEOCODE_TTL_MS) return undefined;
  return entry.result;
}

export async function setCachedGeocode(normalizedQuery: string, result: GeocodeResult | null): Promise<void> {
  const cache = (await get<Record<string, CacheEntry>>(KEYS.geocodeCache)) ?? {};
  cache[normalizedQuery] = { result, storedAt: Date.now() };
  // Trim stale entries occasionally to keep storage bounded.
  const now = Date.now();
  for (const [k, v] of Object.entries(cache)) if (now - v.storedAt > GEOCODE_TTL_MS) delete cache[k];
  await set(KEYS.geocodeCache, cache);
}

// --- Automerge document index ------------------------------------------------

/** origin → Automerge DocumentId. automerge-repo storage doesn't enumerate documents, so we keep an index. */
export async function getDocIndex(): Promise<Record<string, string>> {
  return (await get<Record<string, string>>(KEYS.docIndex)) ?? {};
}

export async function setDocIndex(index: Record<string, string>): Promise<void> {
  await set(KEYS.docIndex, index);
}

export async function getProfilesDocId(): Promise<string | undefined> {
  return get<string>(KEYS.profilesDocId);
}

export async function setProfilesDocId(id: string): Promise<void> {
  await set(KEYS.profilesDocId, id);
}

// --- "Ask each time" decisions for the current browser session ---------------

export async function getAskDecision(profileId: string, origin: string): Promise<boolean | undefined> {
  const d = (await chrome.storage.session.get(KEYS.askDecisions))[KEYS.askDecisions] as Record<string, boolean> | undefined;
  return d?.[`${profileId}|${origin}`];
}

export async function setAskDecision(profileId: string, origin: string, allow: boolean): Promise<void> {
  const d = ((await chrome.storage.session.get(KEYS.askDecisions))[KEYS.askDecisions] as Record<string, boolean> | undefined) ?? {};
  d[`${profileId}|${origin}`] = allow;
  await chrome.storage.session.set({ [KEYS.askDecisions]: d });
}

export async function clearAllStorage(): Promise<void> {
  const keep = await chrome.storage.local.get([KEYS.apiKey, KEYS.settings]);
  await chrome.storage.local.clear();
  await chrome.storage.local.set(keep);
}
