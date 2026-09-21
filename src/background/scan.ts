/**
 * Page-time pipeline: profile matching → page gate → Jev judging → thresholds → resolvers → Automerge.
 */
import { matchId } from "../shared/hash";
import { JEV_MODEL, applicableResolvers, buildRequests, decideStatus, groupAnswers, normalizeAnswer, truthProbability, type JevResponse } from "../shared/jev";
import { broadcast, sendToTab, type CandidatesMsg } from "../shared/messages";
import { matchesAny } from "../shared/matchPatterns";
import { classifySensitiveUrl } from "../shared/sensitive";
import type { CompiledProfile, JevAnswer, Match, ScanSummary } from "../shared/types";
import { systemOne } from "./openrouter";
import { listProfiles, writeScan } from "./repo";
import { getApiKey, getAskDecision, getSettings } from "./storage";
import { runResolvers, type ResolverJob } from "./resolvers";

export interface TabState {
  url: string;
  origin: string;
  profiles: CompiledProfile[];
  /** Set while a "Test on this page" run is active; results aren't persisted. */
  testProfiles?: CompiledProfile[];
  lastScan?: ScanSummary;
  noStore?: boolean;
}

export const tabs = new Map<number, TabState>();

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export interface ActiveProfilesResult {
  profiles: CompiledProfile[];
  skipped?: string;
}

/** Steps 1–3 of profile matching, including the per-page gate. */
export async function resolveActiveProfiles(tabId: number, url: string, title: string, summary: string, noStore: boolean): Promise<ActiveProfilesResult> {
  const origin = originOf(url);
  const state: TabState = tabs.get(tabId) ?? { url, origin, profiles: [] };
  state.url = url;
  state.origin = origin;
  state.profiles = [];
  tabs.set(tabId, state);

  const key = await getApiKey();
  const settings = await getSettings();
  if (!key || !settings.onboarded) return { profiles: [], skipped: "setup incomplete" };

  const all = await listProfiles();
  const forcedHere = all.some((p) => p.enabled && p.scope.siteOverrides?.[origin] === "always");
  const sensitive = classifySensitiveUrl(url);
  if (sensitive && !(forcedHere && sensitive.kind === "host")) return finish(state, [], `skipped: ${sensitive.reason}`);
  if (noStore || state.noStore) return finish(state, [], "skipped: Cache-Control: no-store");

  const candidates: CompiledProfile[] = [];
  for (const p of all) {
    if (!p.enabled) continue;
    const override = p.scope.siteOverrides?.[origin];
    if (override === "never") continue;
    const patternMatch = matchesAny(p.scope.matchPatterns ?? [], url);
    if (override === "always") {
      candidates.push(p);
      continue;
    }
    if (!patternMatch) continue;
    if (override === "ask") {
      const decision = await getAskDecision(p.id, origin);
      if (decision === undefined) {
        await broadcast({ type: "ASK_PROFILE", profileId: p.id, profileName: p.name, origin, tabId });
        continue;
      }
      if (!decision) continue;
    }
    candidates.push(p);
  }
  if (!candidates.length) return finish(state, [], "no matching profiles");

  const gated = await applyPageGates(candidates, url, title, summary);
  return finish(state, gated, gated.length ? undefined : "all profiles gated out");
}

function finish(state: TabState, profiles: CompiledProfile[], skipped?: string): ActiveProfilesResult {
  state.profiles = profiles;
  if (skipped) state.lastScan = { url: state.url, origin: state.origin, scannedAt: new Date().toISOString(), candidates: 0, requests: 0, matches: [], skipped };
  return { profiles, skipped };
}

/** Ask each profile's page gate once, batched in a single Jev request. */
async function applyPageGates(profiles: CompiledProfile[], url: string, title: string, summary: string): Promise<CompiledProfile[]> {
  const gatedProfiles = profiles.filter((p) => p.scope.pageGate);
  if (!gatedProfiles.length) return profiles;
  const questions: Record<string, CompiledProfile["scope"]["pageGate"] & object> = {};
  for (const p of gatedProfiles) questions[`page_gate_${p.id}`] = p.scope.pageGate!;
  let response: JevResponse;
  try {
    response = await systemOne(
      {
        model: JEV_MODEL,
        state: { page: { url, title, lang: "" }, candidates: [{ id: "page", text: summary.slice(0, 1200), tag: "page", source: "page_summary", context: {}, hints: { lat: null, lng: null, placeId: null } }] },
        questions,
      },
      "page_gate",
    );
  } catch (err) {
    console.warn("[page-extractor] page gate failed; running gated profiles anyway", err);
    return profiles;
  }
  return profiles.filter((p) => {
    if (!p.scope.pageGate) return true;
    const raw = response.answers?.[`page_gate_${p.id}`];
    const p1 = truthProbability(normalizeAnswer(raw, p.scope.pageGate) ?? undefined);
    return p1 >= p.scope.pageGateThreshold;
  });
}

/** Steps 4–8: judge, threshold, resolve, store; then notify the tab and the side panel. */
export async function handleCandidates(tabId: number, msg: CandidatesMsg): Promise<ScanSummary> {
  const origin = originOf(msg.url);
  let state = tabs.get(tabId);
  if (!state || state.url !== msg.url) {
    // Service worker may have restarted between GET_ACTIVE_PROFILES and CANDIDATES.
    const res = await resolveActiveProfiles(tabId, msg.url, msg.title, "", false);
    state = tabs.get(tabId)!;
    if (!res.profiles.length && !state.testProfiles) return state.lastScan!;
  }
  const isTest = !!state.testProfiles;
  const profiles = state.testProfiles ?? state.profiles;
  const page = { url: msg.url, title: msg.title, lang: msg.lang || "en" };
  const summary: ScanSummary = { url: msg.url, origin, scannedAt: new Date().toISOString(), candidates: msg.candidates.length, requests: 0, matches: [] };

  try {
    if (!profiles.length || !msg.candidates.length) {
      summary.skipped = profiles.length ? "no candidates" : "no active profiles";
    } else {
      const requests = buildRequests(page, profiles, msg.candidates);
      const responses: JevResponse[] = [];
      let model = JEV_MODEL;
      for (const req of requests) {
        if (!Object.keys(req.questions).length) {
          responses.push({ model, answers: {} });
          continue;
        }
        const res = await systemOne(req, isTest ? "test" : "judge");
        model = res.model || model;
        responses.push(res);
      }
      summary.requests = requests.length;
      const answersByCid = groupAnswers(requests, responses);
      const byId = new Map(msg.candidates.map((c) => [c.id, c]));
      const now = new Date().toISOString();
      const jobs: ResolverJob[] = [];

      for (const [cid, allAnswers] of Object.entries(answersByCid)) {
        const candidate = byId.get(cid);
        if (!candidate) continue;
        for (const profile of profiles) {
          if (!candidate.profiles.includes(profile.id)) continue;
          const answers: { [templateId: string]: JevAnswer } = {};
          for (const t of profile.questions) if (allAnswers[t.id]) answers[t.id] = allAnswers[t.id];
          if (!answers[profile.decision.acceptField]) continue;
          const status = decideStatus(profile, answers);
          if (status === "discard") continue;
          const match: Match = {
            id: matchId(profile.id, candidate.text, msg.url),
            profileId: profile.id,
            profileVersion: profile.version,
            text: candidate.text,
            status,
            answers,
            model,
            domPath: candidate.domPath,
            updatedAt: now,
          };
          if (status === "accepted" && !isTest) {
            const resolvers = applicableResolvers(profile, answers);
            if (resolvers.length) jobs.push({ profile, candidate, match, resolvers });
          }
          summary.matches.push(match);
        }
      }
      if (jobs.length) await runResolvers(jobs, page);

      if (!isTest && summary.matches.length) {
        const doc = await writeScan(origin, msg.url, msg.title, summary.matches);
        // Reflect persisted statuses (user confirmations survive re-scans).
        const stored = doc.pages[msg.url]?.matches ?? [];
        summary.matches = summary.matches.map((m) => stored.find((s) => s.id === m.id) ?? m);
      }
    }
  } catch (err) {
    summary.error = (err as Error).message;
    console.error("[page-extractor] scan failed", err);
  }

  state.lastScan = summary;
  if (isTest) state.testProfiles = undefined;

  await sendToTab(tabId, {
    type: "RESULTS",
    url: msg.url,
    matches: summary.matches.map((m) => ({ id: m.id, profileId: m.profileId, domPath: m.domPath, status: m.status })),
  }).catch(() => undefined);
  await broadcast({ type: "PAGE", tabId, url: msg.url, matches: summary.matches, summary });
  return summary;
}
