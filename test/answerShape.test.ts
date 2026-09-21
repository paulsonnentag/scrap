/**
 * Regression tests built from a real typesafe/jev-1.13 response captured on
 * atlasobscura.com. The earlier normalizer dropped every noul answer because it looked
 * for a `value` field, which made every candidate unjudgeable.
 */
import { describe, expect, it } from "vitest";
import { LOCATIONS_PROFILE } from "../src/background/builtinProfiles";
import { buildRequests, decideStatus, groupAnswers, normalizeAnswer, truthProbability } from "../src/shared/jev";
import type { Candidate, PageDescriptor } from "../src/shared/types";

const NOUL = LOCATIONS_PROFILE.questions[0];
const CHOICE = LOCATIONS_PROFILE.questions[1];

describe("System One answer shape", () => {
  it("reads a noul answer from the field named after its type", () => {
    expect(normalizeAnswer({ type: "noul", noul: 0.75 }, NOUL)).toEqual({ value: true, probability: 0.75 });
    // 0.07 is P(true), so the answer is false with P(false) = 0.93.
    const low = normalizeAnswer({ type: "noul", noul: 0.07 }, NOUL)!;
    expect(low.value).toBe(false);
    expect(low.probability).toBeCloseTo(0.93);
    expect(truthProbability(normalizeAnswer({ type: "noul", noul: 0.07 }, NOUL)!)).toBeCloseTo(0.07);
    expect(truthProbability(normalizeAnswer({ type: "noul", noul: 0.98 }, NOUL)!)).toBeCloseTo(0.98);
  });

  it("reads a choice answer and keeps its distribution and confidence", () => {
    const answer = normalizeAnswer(
      {
        type: "choice",
        choice: "street_address",
        probabilities: { not_a_place: 0.32, street_address: 0.44, city_or_region: 0, business_name: 0.23, landmark: 0.01 },
        confidence: 0.29,
      },
      CHOICE,
    );
    expect(answer).toMatchObject({ value: "street_address", probability: 0.44, confidence: 0.29 });
    expect(answer!.probabilities!.not_a_place).toBe(0.32);
  });

  it("still reads the older and defensive shapes", () => {
    expect(normalizeAnswer({ value: true, probability: 0.91 }, NOUL)).toMatchObject({ value: true, probability: 0.91 });
    expect(normalizeAnswer({ answer: "false", confidence: 0.7 }, NOUL)).toMatchObject({ value: false, probability: 0.7 });
    expect(normalizeAnswer({ probabilities: { landmark: 0.1, street_address: 0.85 } }, CHOICE)).toMatchObject({ value: "street_address", probability: 0.85 });
    expect(normalizeAnswer(0.2, NOUL)).toMatchObject({ value: false, probability: 0.8 });
    expect(normalizeAnswer({ unexpected: 1 }, NOUL)).toBeNull();
  });

  it("judges real candidates end to end instead of discarding them", () => {
    const page: PageDescriptor = { url: "https://www.atlasobscura.com/places/st-pauli-elbtunnel", title: "St. Pauli Elbtunnel in Hamburg", lang: "en" };
    const candidate = (id: string, text: string): Candidate => ({
      id,
      text,
      tag: "ld+json",
      source: "structured_data",
      context: {},
      hints: { lat: null, lng: null, placeId: null },
      profiles: [LOCATIONS_PROFILE.id],
    });
    const candidates = [candidate("c3", "St. Pauli Elbtunnel, Hamburg, DE"), candidate("c2", "1441 Broadway, New York, NY, 10018, US"), candidate("c6", "Get Directions")];
    const requests = buildRequests(page, [LOCATIONS_PROFILE], candidates);

    const answers = groupAnswers(requests, [
      {
        model: "typesafe/jev-1.13-20260917",
        answers: {
          c3_resolve: { type: "noul", noul: 0.98 },
          c3_kind: { type: "choice", choice: "landmark", probabilities: { landmark: 0.96, street_address: 0.03, not_a_place: 0.01 }, confidence: 0.95 },
          c2_resolve: { type: "noul", noul: 0.71 },
          c2_kind: { type: "choice", choice: "street_address", probabilities: { street_address: 1 }, confidence: 0.99 },
          c6_resolve: { type: "noul", noul: 0.07 },
          c6_kind: { type: "choice", choice: "not_a_place", probabilities: { not_a_place: 0.97 }, confidence: 0.97 },
        },
      },
    ]);

    expect(Object.keys(answers).sort()).toEqual(["c2", "c3", "c6"]);
    expect(decideStatus(LOCATIONS_PROFILE, answers.c3)).toBe("accepted");
    expect(decideStatus(LOCATIONS_PROFILE, answers.c2)).toBe("review");
    expect(decideStatus(LOCATIONS_PROFILE, answers.c6)).toBe("discard");
    expect(answers.c3.kind.value).toBe("landmark");
  });
});
