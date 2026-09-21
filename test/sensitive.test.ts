import { describe, expect, it } from "vitest";
import { classifySensitiveUrl, isSensitiveUrl } from "../src/shared/sensitive";

describe("sensitive URL detection", () => {
  it("flags banking, mail, and auth pages", () => {
    expect(isSensitiveUrl("https://www.chase.com/personal")).toMatch(/host/);
    expect(isSensitiveUrl("https://mail.google.com/")).toMatch(/host/);
    expect(isSensitiveUrl("https://mail.google.com/mail/u/0/")).toMatch(/host|path/);
    expect(isSensitiveUrl("https://shop.example.com/login")).toMatch(/path/);
    expect(isSensitiveUrl("https://shop.example.com/checkout/step-2")).toMatch(/path/);
    expect(isSensitiveUrl("chrome://extensions")).toMatch(/browser-internal/);
  });
  it("classifies host heuristics separately from path rules", () => {
    expect(classifySensitiveUrl("https://www.bankrate.com/rates")?.kind).toBe("host");
    expect(classifySensitiveUrl("https://www.bankrate.com/login")?.kind).toBe("path");
    expect(classifySensitiveUrl("https://example.com/")).toBeNull();
  });
  it("does not flag ordinary pages or substrings inside other words", () => {
    expect(isSensitiveUrl("https://blog.example.com/author/jane")).toBeNull();
    expect(isSensitiveUrl("https://example.com/authors")).toBeNull();
    expect(isSensitiveUrl("https://example.com/locations")).toBeNull();
    expect(isSensitiveUrl("https://www.yelp.com/biz/blue-bottle-coffee")).toBeNull();
  });
});
