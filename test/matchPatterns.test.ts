import { describe, expect, it } from "vitest";
import { matchesPattern, needsAllUrls, parseMatchPattern, patternForOrigin } from "../src/shared/matchPatterns";

describe("match patterns", () => {
  it("matches scheme wildcards against http and https only", () => {
    expect(matchesPattern("*://*.yelp.com/*", "https://www.yelp.com/biz/foo")).toBe(true);
    expect(matchesPattern("*://*.yelp.com/*", "http://yelp.com/")).toBe(true);
    expect(matchesPattern("*://*.yelp.com/*", "ftp://yelp.com/")).toBe(false);
  });
  it("matches subdomain wildcards but not unrelated hosts", () => {
    expect(matchesPattern("*://*.example.com/*", "https://notexample.com/")).toBe(false);
    expect(matchesPattern("*://*.example.com/*", "https://a.b.example.com/x")).toBe(true);
  });
  it("matches path globs", () => {
    expect(matchesPattern("*://*/locations*", "https://acme.com/locations")).toBe(true);
    expect(matchesPattern("*://*/locations*", "https://acme.com/locations/berlin?x=1")).toBe(true);
    expect(matchesPattern("*://*/locations*", "https://acme.com/about")).toBe(false);
  });
  it("supports <all_urls> and exact hosts", () => {
    expect(matchesPattern("<all_urls>", "https://anything.org/p")).toBe(true);
    expect(matchesPattern("https://acme.com/*", "https://acme.com/")).toBe(true);
    expect(matchesPattern("https://acme.com/*", "https://www.acme.com/")).toBe(false);
  });
  it("rejects malformed patterns", () => {
    expect(parseMatchPattern("yelp.com")).toBeNull();
    expect(parseMatchPattern("*://a*b.com/")).toBeNull();
    expect(matchesPattern("garbage", "https://x.com")).toBe(false);
  });
  it("derives patterns for origins and detects the all-URLs case", () => {
    expect(patternForOrigin("https://example.com")).toBe("https://example.com/*");
    expect(needsAllUrls("*://*/locations*")).toBe(true);
    expect(needsAllUrls("*://*.yelp.com/*")).toBe(false);
  });
});
