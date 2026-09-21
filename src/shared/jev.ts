/**
 * Pure Jev logic: state building, question expansion, chunking, answer normalization,
 * and threshold decisions. No browser APIs here so it can be unit-tested.
 */
import type {
  Candidate,
  CompiledProfile,
  JevAnswer,
  JevQuestion,
  MatchStatus,
  PageDescriptor,
  ResolverConfig,
  ResolverWhen,
} from "./types";

export const JEV_MODEL = "typesafe/jev-1.13";
export const MAX_STATE_CHARS = 100_000;
export const MAX_CHUNK_CANDIDATES = 50;

/** Candidate as serialized into the Jev state (no domPath, no profiles tagging). */
export interface StateCandidate {
  id: string;
  text: string;
  tag: string;
  source: string;
  context: Candidate["context"];
  hints: Candidate["hints"];
}

export interface JevState {
  page: PageDescriptor;
  candidates: StateCandidate[];
}

export interface JevRequest {
  model: string;
  state: JevState;
  questions: { [questionId: string]: JevQuestion };
}

export interface JevUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cost?: number;
}

export interface JevResponse {
  id?: string;
  model: string;
  provider?: string;
  answers: { [questionId: string]: unknown };
  usage?: JevUsage;
}

export function toStateCandidate(c: Candidate): StateCandidate {
  return { id: c.id, text: c.text, tag: c.tag, source: c.source, context: c.context, hints: c.hints };
}

export function buildState(page: PageDescriptor, candidates: Candidate[]): JevState {
  return { page, candidates: candidates.map(toStateCandidate) };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Question ID for a (candidate, template) pair. */
export function questionId(cid: string, templateId: string): string {
  return `${cid}_${templateId}`;
}

/** Reverse of questionId. Candidate IDs never contain "_" (they're "c17"), so the first "_" splits. */
export function splitQuestionId(qid: string): { cid: string; templateId: string } | null {
  const i = qid.indexOf("_");
  if (i <= 0) return null;
  return { cid: qid.slice(0, i), templateId: qid.slice(i + 1) };
}

export function expandQuestions(profiles: CompiledProfile[], candidates: Candidate[]): { [qid: string]: JevQuestion } {
  const out: { [qid: string]: JevQuestion } = {};
  for (const c of candidates) {
    for (const p of profiles) {
      if (!c.profiles.includes(p.id)) continue;
      for (const t of p.questions) {
        out[questionId(c.id, t.id)] = {
          type: t.type,
          instructions: t.instructions.replaceAll("{cid}", c.id),
          criteria: t.criteria,
        };
      }
    }
  }
  return out;
}

/**
 * Split candidates into chunks so that each request's state stays under MAX_STATE_CHARS
 * and has at most MAX_CHUNK_CANDIDATES candidates. The page descriptor is included in every chunk.
 */
export function chunkCandidates(page: PageDescriptor, candidates: Candidate[]): Candidate[][] {
  const pageChars = JSON.stringify(page).length + 40;
  const chunks: Candidate[][] = [];
  let current: Candidate[] = [];
  let currentChars = pageChars;
  for (const c of candidates) {
    const size = JSON.stringify(toStateCandidate(c)).length + 2;
    const wouldOverflow = current.length > 0 && (currentChars + size > MAX_STATE_CHARS || current.length >= MAX_CHUNK_CANDIDATES);
    if (wouldOverflow) {
      chunks.push(current);
      current = [];
      currentChars = pageChars;
    }
    current.push(c);
    currentChars += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export function buildRequests(page: PageDescriptor, profiles: CompiledProfile[], candidates: Candidate[], model = JEV_MODEL): JevRequest[] {
  return chunkCandidates(page, candidates).map((chunk) => ({
    model,
    state: buildState(page, chunk),
    questions: expandQuestions(profiles, chunk),
  }));
}

/**
 * Normalize a raw answer from the System One endpoint into {value, probability}.
 * The exact response shape should be verified against OpenRouter's reference; this accepts
 * the shapes seen in the SDK docs and a few defensive variants:
 *   - { value, probability }              (documented)
 *   - { answer, confidence }              (variant naming)
 *   - { probabilities: { a: 0.2, b: 0.8 } }  (distribution; pick argmax)
 *   - 0.83                                (bare probability for noul → value = p >= 0.5)
 */
export function normalizeAnswer(raw: unknown, question: JevQuestion): JevAnswer | null {
  if (raw == null) return null;
  if (typeof raw === "number") {
    const p = clamp01(raw);
    if (question.type === "noul") return { value: p >= 0.5, probability: p >= 0.5 ? p : 1 - p };
    return { value: raw, probability: 1 };
  }
  if (typeof raw === "boolean") return { value: raw, probability: 1 };
  if (typeof raw === "string") return { value: raw, probability: 1 };
  if (typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const dist = (o.probabilities ?? o.distribution) as Record<string, number> | undefined;
  if (dist && typeof dist === "object") {
    let best: string | null = null;
    let bestP = -1;
    for (const [k, v] of Object.entries(dist)) {
      if (typeof v === "number" && v > bestP) {
        best = k;
        bestP = v;
      }
    }
    if (best != null) return { value: coerceValue(best, question), probability: clamp01(bestP) };
  }

  const value = o.value ?? o.answer ?? o.choice ?? o.label ?? o.result;
  let probability = o.probability ?? o.confidence ?? o.p ?? o.score;
  if (value === undefined) return null;
  if (typeof probability !== "number") probability = 1;
  const coerced = coerceValue(value, question);
  let p = clamp01(probability as number);
  // Normalize noul so that `probability` always means P(value is true).
  if (question.type === "noul") {
    if (coerced === false) return { value: false, probability: p };
    return { value: true, probability: p };
  }
  return { value: coerced, probability: p };
}

function coerceValue(v: unknown, q: JevQuestion): string | number | boolean {
  if (q.type === "noul") {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v.toLowerCase() === "true" || v.toLowerCase() === "yes";
    if (typeof v === "number") return v >= 0.5;
    return false;
  }
  if (q.type === "score") {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const idx = Object.keys(q.criteria).indexOf(v);
      return idx >= 0 ? idx : v;
    }
  }
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : String(v);
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** P(true) for a noul answer. */
export function truthProbability(answer: JevAnswer | undefined): number {
  if (!answer) return 0;
  return answer.value === true ? answer.probability : 1 - answer.probability;
}

export function decideStatus(profile: CompiledProfile, answers: { [templateId: string]: JevAnswer }): MatchStatus | "discard" {
  const p = truthProbability(answers[profile.decision.acceptField]);
  if (p >= profile.decision.acceptThreshold) return "accepted";
  if (p >= profile.decision.reviewThreshold) return "review";
  return "discard";
}

export function whenMatches(when: ResolverWhen, answers: { [templateId: string]: JevAnswer }): boolean {
  const a = answers[when.field];
  if (!a) return false;
  const v = String(a.value);
  if (when.equals !== undefined) return v === when.equals;
  if (when.in !== undefined) return when.in.includes(v);
  // No condition: run when the field is truthy (noul true, or any non-empty answer).
  if (typeof a.value === "boolean") return a.value;
  return v.length > 0;
}

export function applicableResolvers(profile: CompiledProfile, answers: { [templateId: string]: JevAnswer }): ResolverConfig[] {
  return profile.resolvers.filter((r) => whenMatches(r.when, answers));
}

/** Group normalized answers by candidate and template. */
export function groupAnswers(
  requests: JevRequest[],
  responses: JevResponse[],
): { [cid: string]: { [templateId: string]: JevAnswer } } {
  const grouped: { [cid: string]: { [templateId: string]: JevAnswer } } = {};
  requests.forEach((req, i) => {
    const res = responses[i];
    if (!res) return;
    for (const [qid, raw] of Object.entries(res.answers ?? {})) {
      const q = req.questions[qid];
      const split = splitQuestionId(qid);
      if (!q || !split) continue;
      const norm = normalizeAnswer(raw, q);
      if (!norm) continue;
      (grouped[split.cid] ??= {})[split.templateId] = norm;
    }
  });
  return grouped;
}
