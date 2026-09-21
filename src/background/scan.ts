/**
 * Page-time pipeline: profile matching → page gate → Jev judging → thresholds → resolvers → Automerge.
 *
 * Every stage also records a ScanTrace so the side panel can explain what happened, which is
 * what the debug report is built from. Tracing never changes the pipeline's behaviour.
 */
import type { CandidateTrace, ProfileTrace, ScanTrace, SetupTrace } from "../shared/debug";
import { matchId, newId } from "../shared/hash";
import { JEV_MODEL, applicableResolvers, buildRequests, decideStatus, groupAnswers, normalizeAnswer, truthProbability, type JevResponse } from "../shared/jev";
import { broadcast, sendToTab, type CandidatesMsg } from "../shared/messages";
import { matchesAny, matchesPattern } from "../shared/matchPatterns";
import { classifySensitiveUrl } from "../shared/sensitive";
import type { CompiledProfile, GeocodeResult, JevAnswer, Match, ScanSummary } from "../shared/types";
import { jevCallsSince, logEvent, saveScanTrace } from "./debugLog";
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
  /** Diagnostic trace of the scan in progress or just finished. */
  trace?: ScanTrace;
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

async function buildSetupTrace(all: CompiledProfile[]): Promise<SetupTrace> {
  const [key, settings] = await Promise.all([getApiKey(), getSettings()]);
  let hostPermissions: string[] = [];
  try {
    hostPermissions = (await chrome.permissions.getAll()).origins ?? [];
  } catch {
    // permissions API unavailable
  }
  return {
    hasKey: !!key,
    keyLooksValid: key ? null : false,
    onboarded: settings.onboarded,
    compilerModel: settings.compilerModel,
    jevEndpoint: settings.typesafeBaseUrl && settings.typesafeKey ? "typesafe-direct" : "openrouter",
    profileCount: all.length,
    enabledCount: all.filter((p) => p.enabled).length,
    hostPermissions,
    hasAllUrlsPermission: hostPermissions.includes("<all_urls>") || hostPermissions.includes("*://*/*"),
  };
}

function profileTrace(p: CompiledProfile, url: string, origin: string): ProfileTrace {
  return {
    id: p.id,
    name: p.name,
    enabled: p.enabled,
    builtin: p.builtin,
    customized: p.customized,
    version: p.version,
    matchPatterns: p.scope.matchPatterns ?? [],
    patternMatched: matchesAny(p.scope.matchPatterns ?? [], url),
    override: p.scope.siteOverrides?.[origin],
    sources: p.selection.sources,
    textPatterns: p.selection.textPatterns,
    structuredTypes: p.selection.structuredTypes,
    questionIds: p.questions.map((q) => q.id),
    acceptField: p.decision.acceptField,
    acceptThreshold: p.decision.acceptThreshold,
    reviewThreshold: p.decision.reviewThreshold,
    active: false,
    reason: "",
  };
}

/** Steps 1–3 of profile matching, including the per-page gate. */
export async function resolveActiveProfiles(
  tabId: number,
  url: string,
  title: string,
  summary: string,
  noStore: boolean,
  trigger: ScanTrace["trigger"] = "page-load",
): Promise<ActiveProfilesResult> {
  const origin = originOf(url);
  const state: TabState = tabs.get(tabId) ?? { url, origin, profiles: [] };
  state.url = url;
  state.origin = origin;
  state.profiles = [];
  tabs.set(tabId, state);

  const all = await listProfiles();
  const trace: ScanTrace = {
    scanId: newId(),
    startedAt: new Date().toISOString(),
    url,
    origin,
    title,
    trigger,
    stage: "profile-matching",
    outcome: "",
    setup: await buildSetupTrace(all),
    profiles: all.map((p) => profileTrace(p, url, origin)),
    candidateCount: 0,
    extractors: [],
    candidates: [],
    jevCalls: [],
    resolvers: [],
    errors: [],
  };
  state.trace = trace;
  const traceOf = (id: string) => trace.profiles.find((t) => t.id === id)!;

  if (!trace.setup.hasKey || !trace.setup.onboarded) {
    for (const t of trace.profiles) t.reason = "setup incomplete";
    return finish(state, [], !trace.setup.hasKey ? "setup incomplete: no API key" : "setup incomplete: first run not finished", tabId);
  }

  const forcedHere = all.some((p) => p.enabled && p.scope.siteOverrides?.[origin] === "always");
  const sensitive = classifySensitiveUrl(url);
  trace.sensitive = sensitive?.reason;
  trace.noStore = noStore || state.noStore;
  if (sensitive && !(forcedHere && sensitive.kind === "host")) {
    for (const t of trace.profiles) t.reason = `page is sensitive (${sensitive.reason})`;
    return finish(state, [], `skipped: ${sensitive.reason}`, tabId);
  }
  if (trace.noStore) {
    for (const t of trace.profiles) t.reason = "page served with Cache-Control: no-store";
    return finish(state, [], "skipped: Cache-Control: no-store", tabId);
  }

  const candidates: CompiledProfile[] = [];
  for (const p of all) {
    const t = traceOf(p.id);
    if (!p.enabled) {
      t.reason = "profile is disabled";
      continue;
    }
    const override = p.scope.siteOverrides?.[origin];
    if (override === "never") {
      t.reason = `site override "never run here" for ${origin}`;
      continue;
    }
    const patternMatch = matchesAny(p.scope.matchPatterns ?? [], url);
    if (override === "always") {
      t.reason = `site override "always run here" for ${origin}`;
      candidates.push(p);
      continue;
    }
    if (!patternMatch) {
      t.reason = (p.scope.matchPatterns ?? []).length ? `no pattern matches this URL (${p.scope.matchPatterns.join(", ")})` : "profile has no match patterns, so it runs nowhere until you add one or enable it for this site";
      continue;
    }
    if (override === "ask") {
      const decision = await getAskDecision(p.id, origin);
      if (decision === undefined) {
        t.reason = "waiting for an answer to the per-site prompt in the This page tab";
        await broadcast({ type: "ASK_PROFILE", profileId: p.id, profileName: p.name, origin, tabId });
        continue;
      }
      if (!decision) {
        t.reason = "declined for this site in this browser session";
        continue;
      }
    }
    t.reason = `matched ${p.scope.matchPatterns.find((mp) => matchesPattern(mp, url)) ?? "pattern"}`;
    candidates.push(p);
  }
  if (!candidates.length) return finish(state, [], "no profile applies to this URL", tabId);

  trace.stage = "page-gate";
  const gated = await applyPageGates(candidates, url, title, summary, trace);
  for (const p of gated) {
    const t = traceOf(p.id);
    t.active = true;
    t.reason += "; active";
  }
  return finish(state, gated, gated.length ? undefined : "every applicable profile was rejected by its page gate", tabId);
}

function finish(state: TabState, profiles: CompiledProfile[], skipped: string | undefined, tabId: number): ActiveProfilesResult {
  state.profiles = profiles;
  if (state.trace) {
    if (skipped) {
      state.trace.outcome = skipped;
      state.trace.finishedAt = new Date().toISOString();
      logEvent("info", "scan", `stopped: ${skipped}`, { url: state.url });
    } else {
      state.trace.stage = "extracting";
      state.trace.outcome = "waiting for candidates from the content script";
    }
    saveScanTrace(tabId, state.trace);
  }
  if (skipped) state.lastScan = { url: state.url, origin: state.origin, scannedAt: new Date().toISOString(), candidates: 0, requests: 0, matches: [], skipped };
  return { profiles, skipped };
}

/** Ask each profile's page gate once, batched in a single Jev request. */
async function applyPageGates(profiles: CompiledProfile[], url: string, title: string, summary: string, trace?: ScanTrace): Promise<CompiledProfile[]> {
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
    trace?.errors.push({ where: "page gate", message: (err as Error).message });
    logEvent("warn", "page-gate", `failed, running gated profiles anyway: ${(err as Error).message}`);
    return profiles;
  }
  return profiles.filter((p) => {
    if (!p.scope.pageGate) return true;
    const raw = response.answers?.[`page_gate_${p.id}`];
    const probability = truthProbability(normalizeAnswer(raw, p.scope.pageGate) ?? undefined);
    const passed = probability >= p.scope.pageGateThreshold;
    const t = trace?.profiles.find((x) => x.id === p.id);
    if (t) {
      t.gate = { probability, threshold: p.scope.pageGateThreshold, passed };
      if (!passed) t.reason += `; page gate rejected it (p=${probability.toFixed(2)} < ${p.scope.pageGateThreshold})`;
    }
    return passed;
  });
}

/** Steps 4–8: judge, threshold, resolve, store; then notify the tab and the side panel. */
export async function handleCandidates(tabId: number, msg: CandidatesMsg): Promise<ScanSummary> {
  const origin = originOf(msg.url);
  let state = tabs.get(tabId);
  if (!state || state.url !== msg.url) {
    // Service worker may have restarted between GET_ACTIVE_PROFILES and CANDIDATES.
    const res = await resolveActiveProfiles(tabId, msg.url, msg.title, "", false, msg.trigger ?? "page-load");
    state = tabs.get(tabId)!;
    if (!res.profiles.length && !state.testProfiles) return state.lastScan!;
  }
  const isTest = !!state.testProfiles;
  const profiles = state.testProfiles ?? state.profiles;
  const page = { url: msg.url, title: msg.title, lang: msg.lang || "en" };
  const summary: ScanSummary = { url: msg.url, origin, scannedAt: new Date().toISOString(), candidates: msg.candidates.length, requests: 0, matches: [] };

  const trace = state.trace;
  const judgeStartedAt = new Date().toISOString();
  if (trace) {
    trace.lang = page.lang;
    if (msg.trigger) trace.trigger = msg.trigger;
    trace.candidateCount = msg.candidates.length;
    trace.extractors = (msg.stats ?? []).map((s) => ({
      source: s.source,
      produced: s.produced,
      skippedHidden: s.skippedHidden,
      skippedShort: s.skippedShort,
      deduped: s.deduped,
      kept: s.kept,
      note: s.note,
    }));
    trace.candidates = msg.candidates.map<CandidateTrace>((c) => ({
      id: c.id,
      text: c.text,
      source: c.source,
      tag: c.tag,
      profiles: c.profiles,
      hints: c.hints,
      heading: c.context.heading,
      domPath: c.domPath,
      decisions: [],
    }));
  }

  try {
    if (!profiles.length || !msg.candidates.length) {
      summary.skipped = profiles.length ? "no candidates" : "no active profiles";
      if (trace) trace.outcome = profiles.length ? "the extractors produced no candidates on this page" : "no active profiles when candidates arrived";
    } else {
      if (trace) trace.stage = "judging";
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
        const ct = trace?.candidates.find((c) => c.id === cid);
        for (const profile of profiles) {
          if (!candidate.profiles.includes(profile.id)) continue;
          const answers: { [templateId: string]: JevAnswer } = {};
          for (const t of profile.questions) if (allAnswers[t.id]) answers[t.id] = allAnswers[t.id];
          const acceptAnswer = answers[profile.decision.acceptField];
          if (!acceptAnswer) {
            ct?.decisions.push({ profileId: profile.id, acceptProbability: null, status: "no-answer", answers });
            continue;
          }
          const status = decideStatus(profile, answers);
          ct?.decisions.push({ profileId: profile.id, acceptProbability: truthProbability(acceptAnswer), status, answers });
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
      if (jobs.length) {
        if (trace) trace.stage = "resolving";
        await runResolvers(jobs, page);
        if (trace) {
          for (const job of jobs) {
            for (const [type, value] of Object.entries(job.match.resolved ?? {})) {
              const failed = value && typeof value === "object" && "error" in (value as object);
              trace.resolvers.push({
                type,
                candidateId: job.candidate.id,
                candidateText: job.candidate.text,
                ok: !failed && value !== null,
                detail: failed
                  ? String((value as { error: unknown }).error)
                  : value === null
                    ? "no result (geocoder found nothing, or Jev verification rejected it)"
                    : type === "geocode"
                      ? `${(value as GeocodeResult).lat}, ${(value as GeocodeResult).lng} via ${(value as GeocodeResult).provider}`
                      : JSON.stringify(value).slice(0, 200),
              });
            }
          }
        }
      }

      if (!isTest && summary.matches.length) {
        if (trace) trace.stage = "storing";
        const doc = await writeScan(origin, msg.url, msg.title, summary.matches);
        // Reflect persisted statuses (user confirmations survive re-scans).
        const stored = doc.pages[msg.url]?.matches ?? [];
        summary.matches = summary.matches.map((m) => stored.find((s) => s.id === m.id) ?? m);
      }
      if (trace) {
        const accepted = summary.matches.filter((m) => m.status === "accepted" || m.status === "confirmed").length;
        const review = summary.matches.filter((m) => m.status === "review").length;
        trace.stored = { matches: summary.matches.length, accepted, review };
        trace.outcome = summary.matches.length ? `done: ${accepted} accepted, ${review} in review from ${msg.candidates.length} candidates` : `every one of the ${msg.candidates.length} candidates scored below the review threshold`;
      }
    }
  } catch (err) {
    summary.error = (err as Error).message;
    trace?.errors.push({ where: trace.stage, message: (err as Error).message, stack: (err as Error).stack });
    if (trace) trace.outcome = `failed during ${trace.stage}: ${(err as Error).message}`;
    logEvent("error", "scan", (err as Error).message, { url: msg.url });
  }

  state.lastScan = summary;
  if (isTest) state.testProfiles = undefined;
  if (trace) {
    trace.stage = "done";
    trace.finishedAt = new Date().toISOString();
    // Gate calls happen before the candidates arrive; judging and verification after.
    const gateCalls = jevCallsSince(trace.startedAt).filter((c) => c.purpose === "page_gate");
    trace.jevCalls = [...gateCalls, ...jevCallsSince(judgeStartedAt).filter((c) => c.purpose !== "page_gate")];
    saveScanTrace(tabId, trace);
  }

  await sendToTab(tabId, {
    type: "RESULTS",
    url: msg.url,
    matches: summary.matches.map((m) => ({ id: m.id, profileId: m.profileId, domPath: m.domPath, status: m.status })),
  }).catch(() => undefined);
  await broadcast({ type: "PAGE", tabId, url: msg.url, matches: summary.matches, summary });
  return summary;
}
