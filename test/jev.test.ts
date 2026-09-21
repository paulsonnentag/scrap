import { describe, expect, it } from "vitest";
import {
  MAX_CHUNK_CANDIDATES,
  MAX_STATE_CHARS,
  applicableResolvers,
  buildRequests,
  chunkCandidates,
  decideStatus,
  expandQuestions,
  groupAnswers,
  normalizeAnswer,
  splitQuestionId,
  truthProbability,
} from "../src/shared/jev";
import { LOCATIONS_PROFILE } from "../src/background/builtinProfiles";
import type { Candidate, PageDescriptor } from "../src/shared/types";

const page: PageDescriptor = { url: "https://example.com/locations", title: "Our locations", lang: "en" };

function candidate(i: number, text = `Candidate ${i}`, profiles = [LOCATIONS_PROFILE.id]): Candidate {
  return { id: `c${i}`, text, tag: "li", source: "list_items", context: {}, hints: { lat: null, lng: null, placeId: null }, profiles };
}

describe("question expansion", () => {
  it("produces one question per template per candidate, with {cid} substituted", () => {
    const cands = [candidate(1), candidate(2)];
    const qs = expandQuestions([LOCATIONS_PROFILE], cands);
    expect(Object.keys(qs).sort()).toEqual(["c1_kind", "c1_resolve", "c2_kind", "c2_resolve"]);
    expect(qs.c1_resolve.instructions).toContain("candidate c1");
    expect(qs.c1_resolve.instructions).not.toContain("{cid}");
    expect(qs.c1_kind.type).toBe("choice");
  });
  it("only asks a profile's questions for candidates tagged with that profile", () => {
    const qs = expandQuestions([LOCATIONS_PROFILE], [candidate(1, "x", ["other"])]);
    expect(Object.keys(qs)).toEqual([]);
  });
  it("splits question ids back into candidate and template", () => {
    expect(splitQuestionId("c17_resolve")).toEqual({ cid: "c17", templateId: "resolve" });
    expect(splitQuestionId("c17_is_event")).toEqual({ cid: "c17", templateId: "is_event" });
    expect(splitQuestionId("nounderscore")).toBeNull();
  });
});

describe("chunking", () => {
  it("keeps at most 50 candidates per request", () => {
    const cands = Array.from({ length: 120 }, (_, i) => candidate(i + 1));
    const chunks = chunkCandidates(page, cands);
    expect(chunks.map((c) => c.length)).toEqual([50, 50, 20]);
    expect(chunks.every((c) => c.length <= MAX_CHUNK_CANDIDATES)).toBe(true);
  });
  it("splits when the serialized state would exceed the character budget", () => {
    const big = "x".repeat(300);
    const cands = Array.from({ length: 40 }, (_, i) => ({ ...candidate(i + 1, big), context: { before: "y".repeat(3000), after: "z".repeat(3000) } }));
    const chunks = chunkCandidates(page, cands);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const size = JSON.stringify({ page, candidates: chunk.map(({ profiles, domPath, ...rest }) => rest) }).length;
      expect(size).toBeLessThanOrEqual(MAX_STATE_CHARS);
    }
  });
  it("includes the page descriptor and strips domPath/profiles from every request", () => {
    const reqs = buildRequests(page, [LOCATIONS_PROFILE], [{ ...candidate(1), domPath: "body > li" }]);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].model).toBe("typesafe/jev-1.13");
    expect(reqs[0].state.page).toEqual(page);
    expect(reqs[0].state.candidates[0]).not.toHaveProperty("domPath");
    expect(reqs[0].state.candidates[0]).not.toHaveProperty("profiles");
  });
});

describe("answer normalization", () => {
  const noul = LOCATIONS_PROFILE.questions[0];
  const choice = LOCATIONS_PROFILE.questions[1];
  it("accepts the documented {value, probability} shape", () => {
    expect(normalizeAnswer({ value: true, probability: 0.91 }, noul)).toEqual({ value: true, probability: 0.91 });
    expect(normalizeAnswer({ value: "street_address", probability: 0.8 }, choice)).toEqual({ value: "street_address", probability: 0.8 });
  });
  it("accepts alternate field names and distributions", () => {
    expect(normalizeAnswer({ answer: "false", confidence: 0.7 }, noul)).toEqual({ value: false, probability: 0.7 });
    expect(normalizeAnswer({ probabilities: { landmark: 0.1, street_address: 0.85, not_a_place: 0.05 } }, choice)).toEqual({ value: "street_address", probability: 0.85 });
    expect(normalizeAnswer(0.2, noul)).toEqual({ value: false, probability: 0.8 });
  });
  it("computes P(true) regardless of which side the answer reports", () => {
    expect(truthProbability({ value: true, probability: 0.9 })).toBeCloseTo(0.9);
    expect(truthProbability({ value: false, probability: 0.9 })).toBeCloseTo(0.1);
    expect(truthProbability(undefined)).toBe(0);
  });
});

describe("thresholds and resolvers", () => {
  it("accepts, reviews, or discards by the accept field", () => {
    const at = (p: number) => decideStatus(LOCATIONS_PROFILE, { resolve: { value: true, probability: p } });
    expect(at(0.95)).toBe("accepted");
    expect(at(0.85)).toBe("accepted");
    expect(at(0.6)).toBe("review");
    expect(at(0.3)).toBe("discard");
  });
  it("selects resolvers whose when-condition matches", () => {
    const answers = { resolve: { value: true, probability: 0.95 }, kind: { value: "street_address", probability: 0.8 } };
    expect(applicableResolvers(LOCATIONS_PROFILE, answers).map((r) => r.type)).toEqual(["geocode"]);
    expect(applicableResolvers(LOCATIONS_PROFILE, { ...answers, kind: { value: "city_or_region", probability: 0.9 } })).toEqual([]);
  });
  it("groups raw responses by candidate and template", () => {
    const reqs = buildRequests(page, [LOCATIONS_PROFILE], [candidate(1), candidate(2)]);
    const grouped = groupAnswers(reqs, [
      { model: "jev-1.13.0", answers: { c1_resolve: { value: true, probability: 0.9 }, c1_kind: { value: "landmark", probability: 0.6 }, c2_resolve: { value: false, probability: 0.8 }, bogus: { value: 1 } } },
    ]);
    expect(Object.keys(grouped).sort()).toEqual(["c1", "c2"]);
    expect(grouped.c1.kind.value).toBe("landmark");
    expect(truthProbability(grouped.c2.resolve)).toBeCloseTo(0.2);
  });
});
