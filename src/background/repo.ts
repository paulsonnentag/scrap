/**
 * Automerge storage. One ExtractionDoc per origin, plus a ProfilesDoc.
 * Uses the slim entrypoints and loads the wasm bundled with the extension, because
 * Manifest V3 CSP blocks fetching wasm from a CDN and module service workers
 * can't use top-level await.
 */
import { Repo, initializeWasm, isValidDocumentId, type DocHandle, type DocumentId } from "@automerge/automerge-repo/slim";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import type { CompiledProfile, ExtractionDoc, Match, MatchStatus, ProfilesDoc } from "../shared/types";
import { getDocIndex, getProfilesDocId, setDocIndex, setProfilesDocId } from "./storage";
import { BUILTIN_PROFILES } from "./builtinProfiles";

export const DB_NAME = "page-extractor";

let repoPromise: Promise<Repo> | undefined;

export function getRepo(): Promise<Repo> {
  if (!repoPromise) {
    repoPromise = (async () => {
      const wasm = await fetch(chrome.runtime.getURL("automerge.wasm")).then((r) => r.arrayBuffer());
      await initializeWasm(new Uint8Array(wasm));
      return new Repo({
        storage: new IndexedDBStorageAdapter(DB_NAME),
        network: [],
        sharePolicy: async () => false,
      });
    })();
  }
  return repoPromise;
}

// --- Extraction docs (one per origin) ---------------------------------------

const originHandles = new Map<string, Promise<DocHandle<ExtractionDoc>>>();

export async function getOriginHandle(origin: string, create = true): Promise<DocHandle<ExtractionDoc> | undefined> {
  const cached = originHandles.get(origin);
  if (cached) return cached;
  const p = (async () => {
    const repo = await getRepo();
    const index = await getDocIndex();
    const existingId = index[origin];
    if (existingId && isValidDocumentId(existingId)) {
      try {
        const handle = await repo.find<ExtractionDoc>(existingId as DocumentId);
        await handle.whenReady();
        return handle;
      } catch (err) {
        console.warn("[page-extractor] lost document for", origin, err);
      }
    }
    if (!create) throw new Error("no document");
    const handle = repo.create<ExtractionDoc>({ origin, pages: {} });
    index[origin] = handle.documentId;
    await setDocIndex(index);
    return handle;
  })();
  originHandles.set(origin, p);
  try {
    return await p;
  } catch {
    originHandles.delete(origin);
    return undefined;
  }
}

export async function readOriginDoc(origin: string): Promise<ExtractionDoc | undefined> {
  const handle = await getOriginHandle(origin, false);
  return handle?.doc();
}

/**
 * Write rules: keyed by match.id, never delete (set status rejected instead),
 * one change() call per page scan.
 */
/** Automerge rejects `undefined` values; a JSON round-trip drops them. */
function sanitize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function writeScan(origin: string, url: string, title: string, rawMatches: Match[]): Promise<ExtractionDoc> {
  const handle = await getOriginHandle(origin);
  if (!handle) throw new Error("could not open document");
  const matches = rawMatches.map(sanitize);
  const now = new Date().toISOString();
  handle.change((doc) => {
    if (!doc.pages) doc.pages = {};
    let page = doc.pages[url];
    if (!page) {
      doc.pages[url] = { title, firstSeen: now, lastSeen: now, matches: [] };
      page = doc.pages[url];
    } else {
      page.lastSeen = now;
      if (title && page.title !== title) page.title = title;
    }
    for (const m of matches) {
      const idx = page.matches.findIndex((x) => x.id === m.id);
      if (idx === -1) {
        page.matches.push(m);
        continue;
      }
      const existing = page.matches[idx];
      // Preserve user decisions across re-scans.
      const keepStatus: MatchStatus | undefined = existing.status === "confirmed" || existing.status === "rejected" ? existing.status : undefined;
      existing.profileVersion = m.profileVersion;
      existing.text = m.text;
      existing.status = keepStatus ?? m.status;
      existing.answers = m.answers;
      existing.model = m.model;
      if (m.resolved) existing.resolved = m.resolved;
      if (m.domPath) existing.domPath = m.domPath;
      existing.updatedAt = now;
    }
  });
  await (await getRepo()).flush([handle.documentId]);
  return handle.doc();
}

export async function setMatchStatus(origin: string, url: string, matchId: string, status: MatchStatus): Promise<Match | undefined> {
  const handle = await getOriginHandle(origin, false);
  if (!handle) return undefined;
  let updated: Match | undefined;
  handle.change((doc) => {
    const page = doc.pages?.[url];
    const m = page?.matches.find((x) => x.id === matchId);
    if (m) {
      m.status = status;
      m.updatedAt = new Date().toISOString();
      updated = JSON.parse(JSON.stringify(m));
    }
  });
  await (await getRepo()).flush([handle.documentId]);
  return updated;
}

/** "Clear site": we never delete matches from a doc that could be merged elsewhere, so we drop the whole document. */
export async function clearOrigin(origin: string): Promise<void> {
  const repo = await getRepo();
  const index = await getDocIndex();
  const id = index[origin];
  originHandles.delete(origin);
  if (id && isValidDocumentId(id)) {
    try {
      repo.delete(id as DocumentId);
    } catch (err) {
      console.warn("[page-extractor] delete failed", err);
    }
  }
  delete index[origin];
  await setDocIndex(index);
}

export async function clearAllOrigins(): Promise<void> {
  const index = await getDocIndex();
  for (const origin of Object.keys(index)) await clearOrigin(origin);
}

export async function docSizes(): Promise<Record<string, { bytes: number; pages: number; matches: number }>> {
  const index = await getDocIndex();
  const out: Record<string, { bytes: number; pages: number; matches: number }> = {};
  for (const origin of Object.keys(index)) {
    const doc = await readOriginDoc(origin);
    if (!doc) continue;
    const pages = Object.values(doc.pages ?? {});
    out[origin] = {
      bytes: JSON.stringify(doc).length,
      pages: pages.length,
      matches: pages.reduce((n, p) => n + p.matches.length, 0),
    };
  }
  return out;
}

// --- Profiles doc -------------------------------------------------------------

let profilesHandle: Promise<DocHandle<ProfilesDoc>> | undefined;

export function getProfilesHandle(): Promise<DocHandle<ProfilesDoc>> {
  if (!profilesHandle) {
    profilesHandle = (async () => {
      const repo = await getRepo();
      const id = await getProfilesDocId();
      if (id && isValidDocumentId(id)) {
        try {
          const handle = await repo.find<ProfilesDoc>(id as DocumentId);
          await handle.whenReady();
          return handle;
        } catch (err) {
          console.warn("[page-extractor] lost profiles document", err);
        }
      }
      const initial: ProfilesDoc = { profiles: {} };
      for (const p of BUILTIN_PROFILES) initial.profiles[p.id] = p;
      const handle = repo.create<ProfilesDoc>(initial);
      await setProfilesDocId(handle.documentId);
      await repo.flush([handle.documentId]);
      return handle;
    })();
    profilesHandle.catch(() => (profilesHandle = undefined));
  }
  return profilesHandle;
}

export async function listProfiles(): Promise<CompiledProfile[]> {
  const handle = await getProfilesHandle();
  const doc = handle.doc();
  return Object.values(doc.profiles ?? {}).map((p) => JSON.parse(JSON.stringify(p)) as CompiledProfile);
}

export async function getProfile(id: string): Promise<CompiledProfile | undefined> {
  return (await listProfiles()).find((p) => p.id === id);
}

export async function saveProfile(profile: CompiledProfile): Promise<CompiledProfile> {
  const handle = await getProfilesHandle();
  handle.change((doc) => {
    if (!doc.profiles) doc.profiles = {};
    // Replace wholesale; profiles are small and the doc is the unit of sharing.
    doc.profiles[profile.id] = JSON.parse(JSON.stringify(profile));
  });
  await (await getRepo()).flush([handle.documentId]);
  return profile;
}

export async function updateProfile(id: string, fn: (p: CompiledProfile) => void): Promise<CompiledProfile | undefined> {
  const handle = await getProfilesHandle();
  let found = false;
  handle.change((doc) => {
    const p = doc.profiles?.[id];
    if (p) {
      found = true;
      fn(p);
    }
  });
  if (!found) return undefined;
  await (await getRepo()).flush([handle.documentId]);
  return getProfile(id);
}

export async function deleteProfile(id: string): Promise<void> {
  const handle = await getProfilesHandle();
  handle.change((doc) => {
    if (doc.profiles?.[id]) delete doc.profiles[id];
  });
  await (await getRepo()).flush([handle.documentId]);
}
