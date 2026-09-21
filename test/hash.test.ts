import { describe, expect, it } from "vitest";
import { matchId, normalizeText } from "../src/shared/hash";

describe("match ids", () => {
  it("are stable across whitespace and case differences in text", () => {
    const a = matchId("p1", "  Blue Bottle   Coffee ", "https://x.com/a");
    const b = matchId("p1", "blue bottle coffee", "https://x.com/a");
    expect(a).toBe(b);
  });
  it("differ by profile and url", () => {
    expect(matchId("p1", "t", "u")).not.toBe(matchId("p2", "t", "u"));
    expect(matchId("p1", "t", "u1")).not.toBe(matchId("p1", "t", "u2"));
  });
  it("normalizes text", () => {
    expect(normalizeText("  A  B\n C ")).toBe("a b c");
  });
});
