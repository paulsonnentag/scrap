/**
 * Raw diagnostic dump. No interpretation: exact request and response bodies, the full
 * profile and scan state, and the page source, so a reader can see what actually happened.
 */
import type {
  CandidateHints,
  CandidateSource,
  CollectionStats,
  CompiledProfile,
  JevAnswer,
  MatchStatus,
  SiteOverrideMode,
} from "./types";

export const BUILD_ID: string = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

export interface SetupTrace {
  hasKey: boolean;
  onboarded: boolean;
  compilerModel: string;
  jevEndpoint: "openrouter" | "typesafe-direct";
  profileCount: number;
  enabledCount: number;
  hostPermissions: string[];
}

export interface ProfileTrace {
  id: string;
  name: string;
  enabled: boolean;
  version: number;
  matchPatterns: string[];
  patternMatched: boolean;
  override?: SiteOverrideMode;
  askPending?: boolean;
  askDeclined?: boolean;
  pageGate?: { probability: number; threshold: number; passed: boolean };
  active: boolean;
}

/** One System One call, with the bodies exactly as sent and received. */
export interface JevCallTrace {
  purpose: string;
  pageUrl: string;
  at: string;
  durationMs: number;
  endpoint: string;
  httpStatus?: number;
  ok: boolean;
  /** The exact JSON body POSTed. */
  requestBody: string;
  requestTruncated: boolean;
  /** The exact body received, success or error. */
  responseBody: string;
  responseTruncated: boolean;
  transportError?: string;
}

export interface CandidateDecisionTrace {
  profileId: string;
  acceptField: string;
  acceptProbability: number | null;
  status: MatchStatus | "discard" | "no-answer";
  /** Normalized answers, keyed by question template id. */
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
  value: unknown;
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
  stoppedBecause?: string;
  setup: SetupTrace;
  sensitive?: string;
  noStore?: boolean;
  profiles: ProfileTrace[];
  extractors: CollectionStats[];
  candidateCount: number;
  candidates: CandidateTrace[];
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
  contentBuildId?: string;
  bytesOriginal?: number;
  bytesIncluded?: number;
  truncated?: boolean;
  filtered?: boolean;
  html?: string;
  /** What the content script recorded on its last scan of this page. */
  lastContentScan?: unknown;
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
  /** Full CompiledProfile JSON for every stored profile. */
  profiles: CompiledProfile[];
  jevCalls: JevCallTrace[];
  pageSource: PageSourceTrace;
  log: LogEntry[];
}

// --- Redaction -------------------------------------------------------------------

const KEY_PATTERNS = [/sk-or-v1-[A-Za-z0-9_-]{8,}/g, /sk-[A-Za-z0-9_-]{16,}/g, /Bearer\s+[A-Za-z0-9._-]{12,}/gi];

/** Strip anything that looks like a credential. Applied to the whole dump. */
export function redact(text: string, extraSecrets: string[] = []): string {
  let out = text;
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join("<redacted-key>");
  }
  for (const re of KEY_PATTERNS) out = out.replace(re, "<redacted-key>");
  return out;
}

// --- Rendering ---------------------------------------------------------------------

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (err) {
    return `/* not serializable: ${(err as Error).message} */`;
  }
}

/** Pretty-print a JSON body if it parses, otherwise emit it byte for byte. */
function body(text: string): string {
  if (!text) return "(empty)";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * Render the dump as markdown. Everything is verbatim; nothing is summarized or
 * interpreted. Order: environment, scan state, Jev calls (full bodies), profiles,
 * log, page source.
 */
export function renderDebugReport(report: DebugReport, secrets: string[] = []): string {
  const L: string[] = [];

  L.push("# Page Extractor raw dump", "");
  L.push("```json", json({ generatedAt: report.generatedAt, extensionVersion: report.extensionVersion, buildId: report.buildId, browser: report.browser, tabUrl: report.tabUrl }), "```", "");

  L.push("## Scan trace", "");
  if (!report.scan) L.push("`null` — no scan recorded for this tab in this browser session.", "");
  else L.push("```json", json(report.scan), "```", "");

  L.push("## Jev calls", "");
  if (!report.jevCalls.length) L.push("(none)", "");
  report.jevCalls.forEach((c, i) => {
    L.push(`### [${i + 1}] ${c.purpose} — ${c.ok ? `HTTP ${c.httpStatus}` : c.transportError ? `transport error: ${c.transportError}` : `HTTP ${c.httpStatus ?? "?"}`} — ${c.durationMs} ms — ${c.at}`, "");
    L.push(`\`POST ${c.endpoint}\` for ${c.pageUrl || "(no page url)"}`, "");
    L.push(`Request body${c.requestTruncated ? " (TRUNCATED)" : ""}:`, "", "```json", body(c.requestBody), "```", "");
    L.push(`Response body${c.responseTruncated ? " (TRUNCATED)" : ""}:`, "", "```json", body(c.responseBody), "```", "");
  });

  L.push("## Profiles (stored)", "");
  L.push("```json", json(report.profiles), "```", "");

  L.push("## Event log", "");
  L.push("```json", json(report.log), "```", "");

  L.push("## Page source", "");
  const ps = report.pageSource;
  L.push("```json", json({ ...ps, html: undefined }), "```", "");
  if (ps.html) L.push("```html", ps.html, "```", "");

  return redact(L.join("\n"), secrets);
}
