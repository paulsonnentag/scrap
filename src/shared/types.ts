// Shared data model for the Page Extractor extension.
// Mirrors the specification in docs/SPEC.md.

export type CandidateSource =
  | "structured_data"
  | "semantic_html"
  | "map_embeds"
  | "text_patterns"
  | "headings"
  | "link_text"
  | "table_cells"
  | "list_items";

export const CANDIDATE_SOURCES: CandidateSource[] = [
  "structured_data",
  "semantic_html",
  "map_embeds",
  "text_patterns",
  "headings",
  "link_text",
  "table_cells",
  "list_items",
];

export type JevQuestionType = "noul" | "choice" | "score";

/** A question as sent to Jev. */
export interface JevQuestion {
  type: JevQuestionType;
  instructions: string;
  criteria: { [answer: string]: string };
}

/** A question template. "{cid}" is replaced with the candidate ID. */
export interface JevQuestionTemplate extends JevQuestion {
  id: string;
}

export type SiteOverrideMode = "always" | "never" | "ask";

export type ResolverType = "geocode" | "webhook" | "none";

export interface ResolverWhen {
  field: string;
  equals?: string;
  in?: string[];
}

export interface ResolverConfig {
  type: ResolverType;
  when: ResolverWhen;
  config: Record<string, unknown>;
}

export interface GeocodeResolverConfig {
  provider?: "nominatim";
  verify?: boolean;
  countryBias?: string;
}

export interface WebhookResolverConfig {
  url: string;
  headers?: Record<string, string>;
}

export interface CompiledProfile {
  id: string;
  version: number;
  name: string;
  enabled: boolean;
  /** Set when the user hand-edited compiled output. Recompile won't overwrite without consent. */
  customized?: boolean;
  builtin?: boolean;
  /** The user-facing source the profile was compiled from, kept for editing. */
  source?: UserProfile;
  scope: {
    matchPatterns: string[];
    siteOverrides: { [origin: string]: SiteOverrideMode };
    pageGate?: JevQuestion;
    pageGateThreshold: number;
  };
  selection: {
    sources: CandidateSource[];
    textPatterns?: string[];
    /** JSON-LD @type values this profile cares about (for structured_data). Empty = all. */
    structuredTypes?: string[];
    maxCandidates: number;
    contextChars: number;
  };
  questions: JevQuestionTemplate[];
  decision: {
    acceptField: string;
    acceptThreshold: number;
    reviewThreshold: number;
  };
  resolvers: ResolverConfig[];
  compiler: {
    model: string;
    compiledAt: string;
    sourceHash: string;
  };
}

/** What the user types into the profile editor. */
export interface UserProfile {
  id?: string;
  name: string;
  extract: string;
  matchPatterns: string[];
  pageTypeHint?: string;
  resolvers: ResolverConfig[];
}

export interface CandidateContext {
  heading?: string;
  before?: string;
  after?: string;
}

export interface CandidateHints {
  lat: number | null;
  lng: number | null;
  placeId: string | null;
}

export interface Candidate {
  id: string;
  text: string;
  tag: string;
  source: CandidateSource;
  context: CandidateContext;
  hints: CandidateHints;
  /** IDs of the active profiles whose extractors produced this candidate. */
  profiles: string[];
  /** CSS path used for re-highlighting. Not sent to Jev. */
  domPath?: string;
}

export interface PageDescriptor {
  url: string;
  title: string;
  lang: string;
}

export interface JevAnswer {
  value: string | number | boolean;
  /** P(value). For noul this is P(true) when value is true, P(false) when value is false. */
  probability: number;
  /** The model's own confidence field, when it reports one separately from the distribution. */
  confidence?: number;
  /** Full distribution over options, for choice and score answers. */
  probabilities?: { [option: string]: number };
}

export type MatchStatus = "accepted" | "review" | "rejected" | "confirmed";

export interface Match {
  id: string;
  profileId: string;
  profileVersion: number;
  text: string;
  status: MatchStatus;
  answers: { [questionId: string]: JevAnswer };
  model: string;
  resolved?: { [resolverType: string]: unknown };
  domPath?: string;
  updatedAt: string;
}

export interface GeocodeResult {
  lat: number;
  lng: number;
  provider: string;
  displayName: string;
  confidence: number;
  verified?: boolean;
}

export interface PageRecord {
  title: string;
  firstSeen: string;
  lastSeen: string;
  matches: Match[];
}

export interface ExtractionDoc {
  origin: string;
  pages: { [url: string]: PageRecord };
}

export interface ProfilesDoc {
  profiles: { [id: string]: CompiledProfile };
}

export interface Settings {
  compilerModel: string;
  geocoderProvider: "nominatim";
  geocoderKey?: string;
  /** Optional direct-TypeSafe fallback. */
  typesafeBaseUrl?: string;
  typesafeKey?: string;
  /** First-run completion flag. */
  onboarded: boolean;
}

export interface KeyStatus {
  valid: boolean;
  label?: string;
  credit?: number | null;
  error?: string;
}

export interface SpendRecord {
  totalCost: number;
  totalTokens: number;
  requests: number;
  byPurpose: { [purpose: string]: { cost: number; tokens: number; requests: number } };
}

export interface ScanSummary {
  url: string;
  origin: string;
  scannedAt: string;
  candidates: number;
  requests: number;
  matches: Match[];
  skipped?: string;
  error?: string;
}

/** Per-source extraction statistics, recorded by the content script for debug reports. */
export interface CollectionStats {
  source: CandidateSource;
  note?: string;
  produced: number;
  skippedHidden: number;
  skippedShort: number;
  deduped: number;
  kept: number;
}
