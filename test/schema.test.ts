import { describe, expect, it } from "vitest";
import { BUILTIN_PROFILES } from "../src/background/builtinProfiles";
import { validateCompiledProfile } from "../src/shared/schema";

describe("compiled profile schema", () => {
  it("accepts every built-in profile", () => {
    for (const p of BUILTIN_PROFILES) {
      const r = validateCompiledProfile(p);
      expect(r.errors, p.id).toEqual([]);
      expect(r.ok).toBe(true);
    }
  });
  it("rejects templates that don't reference {cid}", () => {
    const p = structuredClone(BUILTIN_PROFILES[0]);
    p.questions[0].instructions = "Is this a place?";
    const r = validateCompiledProfile(p);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/\{cid\}/);
  });
  it("requires the accept field to be an existing noul question", () => {
    const p = structuredClone(BUILTIN_PROFILES[0]);
    p.decision.acceptField = "kind";
    expect(validateCompiledProfile(p).errors.join("\n")).toMatch(/noul/);
    p.decision.acceptField = "missing";
    expect(validateCompiledProfile(p).errors.join("\n")).toMatch(/not a question id/);
  });
  it("validates criteria shape per question type and threshold ordering", () => {
    const p = structuredClone(BUILTIN_PROFILES[0]);
    p.questions[0].criteria = { yes: "a", no: "b" };
    expect(validateCompiledProfile(p).errors.join("\n")).toMatch(/noul criteria/);
    const q = structuredClone(BUILTIN_PROFILES[0]);
    q.decision.reviewThreshold = 0.9;
    expect(validateCompiledProfile(q).errors.join("\n")).toMatch(/reviewThreshold/);
  });
  it("rejects invalid regexes and webhooks without URLs", () => {
    const p = structuredClone(BUILTIN_PROFILES[0]);
    p.selection.textPatterns = ["(unclosed"];
    expect(validateCompiledProfile(p).errors.join("\n")).toMatch(/invalid regex/);
    const q = structuredClone(BUILTIN_PROFILES[0]);
    q.resolvers = [{ type: "webhook", when: { field: "resolve" }, config: {} }];
    expect(validateCompiledProfile(q).errors.join("\n")).toMatch(/webhook resolver requires config.url/);
  });
});
