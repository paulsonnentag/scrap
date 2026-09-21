/**
 * Debug report: a single pasteable document describing what happened on the last scan
 * of a page, why it produced (or didn't produce) matches, and the page source that was
 * scanned. Types and rendering live here so the background can build a report and the
 * side panel can render it without duplicating the format.
 */
import type {
  CandidateHints,
  CandidateSource,
  JevAnswer,
  MatchStatus,
  SiteOverrideMode,
} from "./types";

export const BUILD_ID: string = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

export interface SetupTrace {
  hasKey: boolean;
  keyLooksValid: boolean | null;
  onboarded: boolean;
  compilerModel: string;
  jevEndpoint: "openrouter" | "typesafe-direct";
  profileCount: number;
  enabledCount: number;
  hostPermissions: string[];
  hasAllUrlsPermission: boolean;
}

export interface ProfileTrace {
  id: string;
  name: string;
  enabled: boolean;
  builtin?: boolean;
  customized?: boolean;
  version: number;
  matchPatterns: string[];
  patternMatched: boolean;
  override?: SiteOverrideMode;
  sources: CandidateSource[];
  textPatterns?: string[];
  structuredTypes?: string[];
  questionIds: string[];
  acceptField: string;
  acceptThreshold: number;
  reviewThreshold: number;
  gate?: { probability: number; threshold: number; passed: boolean };
  active: boolean;
  /** Why this profile did or did not run on this page. */
  reason: string;
}

export interface ExtractorTrace {
  source: CandidateSource;
  /** Elements/matches the extractor produced before dedupe. */
  produced: number;
  /** Nodes rejected because they sit in nav/footer/script/hidden subtrees or have no box. */
  skippedHidden: number;
  /** Nodes rejected for having too little text. */
  skippedShort: number;
  /** Candidates dropped as duplicates of another candidate's text. */
  deduped: number;
  /** Candidates that survived into the final list. */
  kept: number;
  note?: string;
}

export interface JevCallTrace {
  purpose: string;
  pageUrl: string;
  at: string;
  durationMs: number;
  requestModel: string;
  candidates: number;
  questions: number;
  stateChars: number;
  ok: boolean;
  httpStatus?: number;
  errorSnippet?: string;
  responseModel?: string;
  provider?: string;
  cost?: number;
  tokens?: number;
  /** Answer keys the response contained. */
  answersReturned: number;
  /** Answer keys that did not correspond to a question we asked. */
  answersUnmatched: number;
  /** Answers our normalizer could not interpret. This is the signal for a response-shape mismatch. */
  answersUnparsed: number;
  sampleQuestion?: { id: string; type: string; instructions: string; criteria: Record<string, string> };
  sampleRawAnswer?: unknown;
  /** First bytes of the raw response body, for shape debugging. */
  rawResponseSnippet?: string;
}

export interface CandidateDecisionTrace {
  profileId: string;
  acceptProbability: number | null;
  status: MatchStatus | "discard" | "no-answer";
  answers: { [templateId: string]: JevAnswer };
}

export interface CandidateTrace {
  id: string;
  text: string;
  source: CandidateSource;
  tag: string;
  profiles: string[];
  hints: CandidateHints;
  heading?: string;
  domPath?: string;
  decisions: CandidateDecisionTrace[];
}

export interface ResolverTrace {
  type: string;
  candidateId: string;
  candidateText: string;
  ok: boolean;
  detail: string;
}

export type ScanStage = "profile-matching" | "page-gate" | "extracting" | "judging" | "resolving" | "storing" | "done";

export interface ScanTrace {
  scanId: string;
  startedAt: string;
  finishedAt?: string;
  url: string;
  origin: string;
  title: string;
  lang?: string;
  trigger: "page-load" | "rescan" | "test";
  stage: ScanStage;
  /** One-line summary of where the pipeline stopped, or "done". */
  outcome: string;
  setup: SetupTrace;
  sensitive?: string;
  noStore?: boolean;
  profiles: ProfileTrace[];
  extractors: ExtractorTrace[];
  candidateCount: number;
  candidates: CandidateTrace[];
  jevCalls: JevCallTrace[];
  resolvers: ResolverTrace[];
  stored?: { matches: number; accepted: number; review: number };
  errors: Array<{ where: string; message: string; stack?: string }>;
}

export interface PageSourceTrace {
  available: boolean;
  via: "content-script" | "scripting-api" | "unavailable";
  error?: string;
  readyState?: string;
  frameCount?: number;
  /** Build id of the content script that answered. Differs from the background's when the page needs a reload. */
  contentBuildId?: string;
  bytesOriginal?: number;
  bytesIncluded?: number;
  truncated?: boolean;
  filtered?: boolean;
  html?: string;
}

export interface LogEntry {
  at: string;
  level: "info" | "warn" | "error";
  where: string;
  message: string;
  detail?: unknown;
}

export interface DebugReport {
  generatedAt: string;
  extensionVersion: string;
  buildId: string;
  browser: string;
  tabUrl: string;
  scan?: ScanTrace;
  pageSource: PageSourceTrace;
  log: LogEntry[];
  /** Ranked, human-readable guesses at what went wrong, most likely first. */
  diagnosis: string[];
}

// --- Redaction -------------------------------------------------------------------

const KEY_PATTERNS = [/sk-or-v1-[A-Za-z0-9_-]{8,}/g, /sk-[A-Za-z0-9_-]{16,}/g, /Bearer\s+[A-Za-z0-9._-]{12,}/gi];

/** Strip anything that looks like a credential. Applied to every string we emit. */
export function redact(text: string, extraSecrets: string[] = []): string {
  let out = text;
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join("«redacted-key»");
  }
  for (const re of KEY_PATTERNS) out = out.replace(re, "«redacted-key»");
  return out;
}

// --- Diagnosis --------------------------------------------------------------------

/**
 * Rank the likely reasons a page produced no (or unexpected) matches. Ordered most
 * specific first, so the first line is usually the actionable one.
 */
export function diagnose(report: DebugReport): string[] {
  const out: string[] = [];
  const scan = report.scan;

  if (!scan) {
    out.push("No scan has run for this tab in this browser session. Reload the page, or press Rescan, then generate the report again.");
    if (report.pageSource.via === "unavailable") {
      out.push("The content script did not answer, so it is probably not injected on this page. Extensions do not reach pages that were already open when the extension was installed or reloaded: reload the tab. Content scripts also never run on chrome:// pages, the Chrome Web Store, PDF viewers, or other extensions' pages.");
    }
    return out;
  }

  if (report.pageSource.contentBuildId && report.pageSource.contentBuildId !== report.buildId) {
    out.push(`The page is running content script build ${report.pageSource.contentBuildId} but the extension is build ${report.buildId}. Reload the page so it picks up the current code.`);
  }

  const s = scan.setup;
  if (!s.hasKey) out.push("No OpenRouter API key is stored. Add one in Settings; nothing is scanned until a key is verified.");
  else if (s.keyLooksValid === false) out.push("The stored OpenRouter key did not verify. Re-check it in Settings.");
  if (!s.onboarded) out.push("First-run setup was never completed, so scanning stays off. Finish the three steps in Settings.");
  if (scan.sensitive) out.push(`This URL is treated as sensitive (${scan.sensitive}), so it is never scanned. If that is wrong, set the profile to "Always run here" for this site; that overrides host-name heuristics but not authentication or payment paths.`);
  if (scan.noStore) out.push("The page was served with Cache-Control: no-store, so it is skipped by design.");

  if (s.enabledCount === 0) out.push("No profile is enabled. Enable one in the Profiles tab.");
  else {
    const enabled = scan.profiles.filter((p) => p.enabled);
    const active = scan.profiles.filter((p) => p.active);
    if (!active.length && enabled.length) {
      const noPattern = enabled.filter((p) => !p.patternMatched && p.override !== "always");
      if (noPattern.length === enabled.length) {
        out.push(`No enabled profile matches this URL. Patterns: ${noPattern.map((p) => `${p.name} → ${p.matchPatterns.length ? p.matchPatterns.join(", ") : "(none)"}`).join(" | ")}. Add a pattern, or use the per-site switch "Always run here" on this origin.`);
      }
      const never = enabled.filter((p) => p.override === "never");
      if (never.length) out.push(`${never.map((p) => p.name).join(", ")} has a "Never run here" override for this origin, which beats every pattern.`);
      const asked = enabled.filter((p) => p.override === "ask");
      if (asked.length) out.push(`${asked.map((p) => p.name).join(", ")} is set to "Ask each time" and is waiting for an answer in the This page tab.`);
      const gated = enabled.filter((p) => p.gate && !p.gate.passed);
      if (gated.length) out.push(`The page gate rejected ${gated.map((p) => `${p.name} (p=${p.gate!.probability.toFixed(2)} < ${p.gate!.threshold})`).join(", ")}. Lower pageGateThreshold or reword the gate question if the page really is in scope.`);
    }
  }

  if (scan.stage === "extracting" || scan.candidateCount === 0) {
    if (scan.profiles.some((p) => p.active)) {
      const sources = Array.from(new Set(scan.profiles.filter((p) => p.active).flatMap((p) => p.sources)));
      const skipped = scan.extractors.reduce((n, e) => n + e.skippedHidden, 0);
      out.push(`The extractors produced no candidates. Sources tried: ${sources.join(", ")}. ${skipped} node(s) were skipped as hidden or inside nav/footer. If the content is rendered late by JavaScript, press Rescan once it is visible; the content script scans at document_idle and on history navigations, not on every DOM mutation.`);
      if (sources.includes("text_patterns")) {
        const pats = Array.from(new Set(scan.profiles.filter((p) => p.active).flatMap((p) => p.textPatterns ?? [])));
        if (pats.length) out.push(`Check the profile's text patterns against the page source below: ${pats.map((p) => "/" + p + "/").join(", ")}`);
      }
    }
  }

  const failedCalls = scan.jevCalls.filter((c) => !c.ok);
  for (const c of failedCalls) {
    out.push(`The ${c.purpose} request to Jev failed with HTTP ${c.httpStatus ?? "?"}: ${c.errorSnippet ?? "no body"}. ${c.httpStatus === 401 || c.httpStatus === 403 ? "That is an auth problem: check the key and that it has credit." : c.httpStatus === 404 ? "The System One endpoint path may have changed; verify it against OpenRouter's current reference." : c.httpStatus === 429 ? "Rate limited; the client retries with backoff." : ""}`);
  }
  const shapeProblem = scan.jevCalls.find((c) => c.ok && c.answersReturned > 0 && c.answersUnparsed === c.answersReturned);
  if (shapeProblem) {
    out.push("Jev answered, but none of the answers could be interpreted, which means the response shape differs from what this build expects. The raw sample answer is included below; paste it back so the normalizer can be adjusted.");
  } else {
    const partial = scan.jevCalls.find((c) => c.ok && c.answersUnparsed > 0);
    if (partial) out.push(`${partial.answersUnparsed} of ${partial.answersReturned} answers could not be interpreted. See the raw sample answer below.`);
  }
  const missing = scan.jevCalls.find((c) => c.ok && c.questions > 0 && c.answersReturned === 0);
  if (missing) out.push("Jev returned an empty answers object for questions we asked. Check the request/response pair below.");

  if (scan.candidateCount > 0 && scan.jevCalls.some((c) => c.ok) && !scan.candidates.some((c) => c.decisions.some((d) => d.status === "accepted" || d.status === "review"))) {
    const best = scan.candidates
      .flatMap((c) => c.decisions.map((d) => ({ text: c.text, p: d.acceptProbability ?? 0, profileId: d.profileId })))
      .sort((a, b) => b.p - a.p)
      .slice(0, 3);
    if (best.length) {
      const thresholds = scan.profiles.filter((p) => p.active).map((p) => `${p.name}: review ≥ ${p.reviewThreshold}, accept ≥ ${p.acceptThreshold}`);
      out.push(`Every candidate scored below the review threshold, so all were discarded. Highest scores: ${best.map((b) => `"${b.text.slice(0, 40)}" p=${b.p.toFixed(2)}`).join(", ")}. Thresholds: ${thresholds.join("; ")}. Either the question wording does not fit this page's content, or the thresholds are too strict.`);
    }
  }

  const resolverFailures = scan.resolvers.filter((r) => !r.ok);
  if (resolverFailures.length) out.push(`${resolverFailures.length} resolver run(s) failed: ${resolverFailures.slice(0, 3).map((r) => `${r.type} on "${r.candidateText.slice(0, 30)}" → ${r.detail}`).join("; ")}`);

  for (const e of scan.errors) out.push(`Error during ${e.where}: ${e.message}`);

  if (!out.length) {
    const accepted = scan.candidates.filter((c) => c.decisions.some((d) => d.status === "accepted")).length;
    out.push(`No problem detected: the scan completed and produced ${accepted} accepted match(es) from ${scan.candidateCount} candidate(s).`);
  }
  return out;
}

// --- Rendering ---------------------------------------------------------------------

function table(headers: string[], rows: string[][]): string {
  const esc = (s: string) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`)].join("\n");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `… (+${s.length - n} chars)` : s;
}

/** Render the report as markdown meant to be pasted into a chat. */
export function renderDebugReport(report: DebugReport, secrets: string[] = []): string {
  const L: string[] = [];
  const scan = report.scan;
  L.push("# Page Extractor debug report", "");
  L.push(`Generated ${report.generatedAt} · extension ${report.extensionVersion} (build ${report.buildId}) · ${report.browser}`, "");

  L.push("## Verdict", "");
  report.diagnosis.forEach((d, i) => L.push(`${i + 1}. ${d}`));
  L.push("");

  L.push("## Page", "");
  L.push(
    table(
      ["field", "value"],
      [
        ["url", report.tabUrl],
        ["title", scan?.title ?? "(unknown)"],
        ["lang", scan?.lang ?? "(unknown)"],
        ["readyState", report.pageSource.readyState ?? "(unknown)"],
        ["frames", String(report.pageSource.frameCount ?? "(unknown)")],
        ["content script build", report.pageSource.contentBuildId ?? "(did not answer)"],
        ["scan trigger", scan?.trigger ?? "(none)"],
        ["scan stage reached", scan?.stage ?? "(none)"],
        ["outcome", scan?.outcome ?? "no scan recorded for this tab"],
      ],
    ),
    "",
  );

  if (scan) {
    const s = scan.setup;
    L.push("## Setup", "");
    L.push(
      table(
        ["field", "value"],
        [
          ["API key stored", s.hasKey ? "yes" : "NO"],
          ["key verified", s.keyLooksValid === null ? "not checked" : s.keyLooksValid ? "yes" : "NO"],
          ["onboarded", s.onboarded ? "yes" : "NO"],
          ["compiler model", s.compilerModel],
          ["Jev endpoint", s.jevEndpoint],
          ["profiles", `${s.profileCount} (${s.enabledCount} enabled)`],
          ["host permissions", s.hostPermissions.join(", ") || "(none)"],
          ["all-URLs permission", s.hasAllUrlsPermission ? "granted" : "not granted"],
          ["sensitive-URL verdict", scan.sensitive ?? "not sensitive"],
          ["Cache-Control: no-store", scan.noStore ? "yes (skipped)" : "no"],
        ],
      ),
      "",
    );

    L.push("## Profiles considered", "");
    L.push(
      table(
        ["profile", "enabled", "patterns", "url match", "site override", "page gate", "active", "reason"],
        scan.profiles.map((p) => [
          p.name,
          p.enabled ? "yes" : "no",
          p.matchPatterns.join(" ") || "(none)",
          p.patternMatched ? "yes" : "no",
          p.override ?? "-",
          p.gate ? `${p.gate.probability.toFixed(2)} vs ${p.gate.threshold} → ${p.gate.passed ? "pass" : "fail"}` : "-",
          p.active ? "YES" : "no",
          p.reason,
        ]),
      ),
      "",
    );
    const active = scan.profiles.filter((p) => p.active);
    if (active.length) {
      L.push("### Active profile configuration", "");
      for (const p of active) {
        L.push(`**${p.name}** (v${p.version}${p.builtin ? ", built-in" : ""}${p.customized ? ", customized" : ""})`, "");
        L.push(`- sources: ${p.sources.join(", ")}`);
        if (p.textPatterns?.length) L.push(`- textPatterns: ${p.textPatterns.map((t) => "`" + t + "`").join(", ")}`);
        if (p.structuredTypes?.length) L.push(`- structuredTypes: ${p.structuredTypes.join(", ")}`);
        L.push(`- questions: ${p.questionIds.join(", ")}`);
        L.push(`- accept on \`${p.acceptField}\` ≥ ${p.acceptThreshold}, review ≥ ${p.reviewThreshold}`, "");
      }
    }

    L.push("## Extraction", "");
    L.push(`${scan.candidateCount} candidate(s) sent to Jev.`, "");
    if (scan.extractors.length) {
      L.push(
        table(
          ["source", "produced", "skipped (hidden/nav)", "skipped (too short)", "deduped", "kept", "note"],
          scan.extractors.map((e) => [e.source, String(e.produced), String(e.skippedHidden), String(e.skippedShort), String(e.deduped), String(e.kept), e.note ?? ""]),
        ),
        "",
      );
    } else L.push("_No extractor statistics recorded (the content script may not have run)._", "");

    L.push("## Jev calls", "");
    if (!scan.jevCalls.length) L.push("_No Jev request was made._", "");
    for (const c of scan.jevCalls) {
      L.push(`### ${c.purpose} · ${c.ok ? "ok" : `FAILED (HTTP ${c.httpStatus ?? "?"})`}`, "");
      L.push(
        table(
          ["field", "value"],
          [
            ["model requested", c.requestModel],
            ["model that answered", c.responseModel ?? "(none)"],
            ["provider", c.provider ?? "-"],
            ["candidates in state", String(c.candidates)],
            ["questions asked", String(c.questions)],
            ["state size (chars)", String(c.stateChars)],
            ["duration", `${c.durationMs} ms`],
            ["answers returned", String(c.answersReturned)],
            ["answers not matching a question", String(c.answersUnmatched)],
            ["answers we could not interpret", String(c.answersUnparsed)],
            ["cost", c.cost != null ? `$${c.cost}` : "(not reported)"],
            ["tokens", c.tokens != null ? String(c.tokens) : "(not reported)"],
          ],
        ),
        "",
      );
      if (c.sampleQuestion) {
        L.push("Sample question sent:", "", "```json", truncate(JSON.stringify(c.sampleQuestion, null, 2), 1200), "```", "");
      }
      if (c.sampleRawAnswer !== undefined) {
        L.push("Raw answer received for that question (verbatim, before normalization):", "", "```json", truncate(JSON.stringify(c.sampleRawAnswer, null, 2), 1200), "```", "");
      }
      if (c.errorSnippet) L.push("Error body:", "", "```", truncate(c.errorSnippet, 1500), "```", "");
      else if (c.rawResponseSnippet) L.push("Raw response (first bytes):", "", "```json", truncate(c.rawResponseSnippet, 1500), "```", "");
    }

    if (scan.candidates.length) {
      L.push("## Candidates and decisions", "");
      L.push(
        table(
          ["id", "source", "tag", "profiles", "text", "p(accept)", "status", "other answers"],
          scan.candidates.map((c) => {
            const d = c.decisions[0];
            const others = d ? Object.entries(d.answers).filter(([k]) => !scan.profiles.find((p) => p.id === d.profileId && p.acceptField === k)).map(([k, v]) => `${k}=${String(v.value)}(${v.probability.toFixed(2)})`).join(" ") : "";
            return [c.id, c.source, c.tag, c.profiles.join(","), truncate(c.text, 90), d?.acceptProbability != null ? d.acceptProbability.toFixed(3) : "-", d?.status ?? "not judged", others];
          }),
        ),
        "",
      );
    }

    if (scan.resolvers.length) {
      L.push("## Resolvers", "");
      L.push(table(["type", "candidate", "ok", "detail"], scan.resolvers.map((r) => [r.type, truncate(r.candidateText, 50), r.ok ? "yes" : "NO", truncate(r.detail, 120)])), "");
    }

    if (scan.stored) L.push("## Storage", "", `Wrote ${scan.stored.matches} match(es) to the Automerge document for this origin (${scan.stored.accepted} accepted, ${scan.stored.review} in review).`, "");
    if (scan.errors.length) {
      L.push("## Errors", "");
      for (const e of scan.errors) L.push("```", `${e.where}: ${e.message}`, e.stack ?? "", "```", "");
    }
  }

  if (report.log.length) {
    L.push("## Event log", "", "```");
    for (const e of report.log) L.push(`${e.at} ${e.level.toUpperCase().padEnd(5)} ${e.where}: ${e.message}${e.detail !== undefined ? " " + truncate(JSON.stringify(e.detail), 300) : ""}`);
    L.push("```", "");
  }

  L.push("## Page source", "");
  const ps = report.pageSource;
  if (!ps.available) {
    L.push(`_Not captured (${ps.via}): ${ps.error ?? "unknown reason"}._`, "");
  } else {
    L.push(`Captured via ${ps.via}. ${ps.bytesOriginal?.toLocaleString() ?? "?"} chars on the page, ${ps.bytesIncluded?.toLocaleString() ?? "?"} included${ps.truncated ? " (truncated)" : ""}${ps.filtered ? ". Inline script and style bodies were replaced with placeholders; JSON-LD is kept verbatim" : ""}.`, "");
    L.push("```html", ps.html ?? "", "```", "");
  }

  return redact(L.join("\n"), secrets);
}
