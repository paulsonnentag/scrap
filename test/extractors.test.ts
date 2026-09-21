// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { collectCandidates } from "../src/content/extractors";
import { CONTACTS_PROFILE, LOCATIONS_PROFILE, PRICES_PROFILE } from "../src/background/builtinProfiles";

const PAGE = `
<html lang="en"><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"CafeOrCoffeeShop","name":"Blue Bottle Coffee","address":{"@type":"PostalAddress","streetAddress":"66 Mint St","addressLocality":"San Francisco","postalCode":"94103"},"geo":{"@type":"GeoCoordinates","latitude":37.7823,"longitude":-122.4076}}</script>
</head><body>
<nav><a href="https://ignored.example.com/">Nav link to skip</a><address>Nav address to skip</address></nav>
<h1>Our locations</h1>
<p>Visit us at any of our three cafes.</p>
<address>Blue Bottle Coffee, 66 Mint St, San Francisco, CA 94103</address>
<p>Open daily 7am–6pm.</p>
<ul>
  <li><strong>Ferry Building</strong> — 1 Ferry Building, San Francisco, CA 94111</li>
  <li>Email <a href="mailto:hello@bluebottle.com">hello@bluebottle.com</a> or call (510) 653-3394</li>
</ul>
<iframe title="Mint St map" src="https://www.google.com/maps/embed?pb=x&q=37.7823,-122.4076"></iframe>
<a href="https://partner.example.org/">Partner site</a>
<table><tr><td>Espresso</td><td>$4.50</td></tr></table>
<footer><address>1 Corporate HQ Way, Oakland</address></footer>
<div aria-hidden="true">Hidden 99 Secret St, Nowhere</div>
</body></html>`;

beforeAll(() => {
  document.documentElement.innerHTML = PAGE;
  // jsdom has no layout; pretend everything renders.
  Element.prototype.getClientRects = function () {
    return [{}] as unknown as DOMRectList;
  };
});

describe("candidate extraction", () => {
  it("collects from the profile's sources, skipping nav/footer/hidden nodes", () => {
    const cands = collectCandidates([LOCATIONS_PROFILE]);
    const texts = cands.map((c) => c.text);
    expect(texts).toContain("Blue Bottle Coffee, 66 Mint St, San Francisco, CA 94103");
    expect(texts.some((t) => t.includes("Ferry Building"))).toBe(true);
    expect(texts).not.toContain("Nav address to skip");
    expect(texts).not.toContain("1 Corporate HQ Way, Oakland");
    expect(texts.some((t) => t.includes("Secret St"))).toBe(false);
  });
  it("assigns sequential ids, tags DOM nodes, and records dom paths and context", () => {
    const cands = collectCandidates([LOCATIONS_PROFILE]);
    expect(cands.map((c) => c.id)).toEqual(cands.map((_, i) => `c${i + 1}`));
    const addr = cands.find((c) => c.source === "semantic_html")!;
    expect(addr.tag).toBe("address");
    expect(addr.profiles).toEqual([LOCATIONS_PROFILE.id]);
    expect(addr.domPath).toBeTruthy();
    expect(document.querySelector(addr.domPath!)?.getAttribute("data-geo-id")).toBe(addr.id);
    expect(addr.context.heading).toBe("Our locations");
    expect(addr.context.before).toContain("three cafes");
    expect(addr.context.after).toContain("Open daily");
  });
  it("carries coordinates from JSON-LD and map embeds as hints", () => {
    const cands = collectCandidates([LOCATIONS_PROFILE]);
    const ld = cands.find((c) => c.source === "structured_data")!;
    expect(ld.hints.lat).toBeCloseTo(37.7823);
    expect(ld.hints.lng).toBeCloseTo(-122.4076);
    const map = cands.find((c) => c.source === "map_embeds")!;
    expect(map.hints.lat).toBeCloseTo(37.7823);
  });
  it("dedupes identical text across sources and orders by source priority", () => {
    const cands = collectCandidates([LOCATIONS_PROFILE]);
    const norm = cands.map((c) => c.text.toLowerCase());
    expect(new Set(norm).size).toBe(norm.length);
    const order = ["structured_data", "semantic_html", "map_embeds", "text_patterns", "headings", "link_text", "table_cells", "list_items"];
    const idx = cands.map((c) => order.indexOf(c.source));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });
  it("runs the union of sources once and tags candidates per profile", () => {
    const cands = collectCandidates([CONTACTS_PROFILE, PRICES_PROFILE]);
    const email = cands.find((c) => c.text === "hello@bluebottle.com")!;
    expect(email.profiles).toContain(CONTACTS_PROFILE.id);
    const phone = cands.find((c) => c.text === "(510) 653-3394")!;
    expect(phone.source).toBe("text_patterns");
    expect(phone.profiles).toEqual([CONTACTS_PROFILE.id]);
    // table_cells is a source of both profiles, so cells are tagged with both.
    const cell = cands.find((c) => c.text === "Espresso")!;
    expect(cell.profiles.sort()).toEqual([CONTACTS_PROFILE.id, PRICES_PROFILE.id].sort());
    const price = cands.find((c) => c.text === "$4.50")!;
    expect(price.profiles).toContain(PRICES_PROFILE.id);
  });
  it("respects maxCandidates", () => {
    const small = { ...LOCATIONS_PROFILE, selection: { ...LOCATIONS_PROFILE.selection, maxCandidates: 2 } };
    expect(collectCandidates([small])).toHaveLength(2);
  });
});
