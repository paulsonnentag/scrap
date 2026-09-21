import type { Candidate, CandidateContext, CandidateHints, CandidateSource, CompiledProfile } from "../shared/types";
import { adjacentText, buildTextIndex, cleanText, cssPath, elementText, externalHost, isSkipped, normalizeText, precedingHeading } from "./dom";

export interface RawCandidate {
  el: Element | null;
  text: string;
  tag: string;
  source: CandidateSource;
  hints: CandidateHints;
  /** Extra context supplied by the extractor (e.g. JSON-LD type). */
  context?: Partial<CandidateContext>;
  profiles: Set<string>;
}

const NO_HINTS = (): CandidateHints => ({ lat: null, lng: null, placeId: null });

type Extractor = (profiles: CompiledProfile[]) => RawCandidate[];

function tagAll(list: RawCandidate[], profiles: CompiledProfile[]): RawCandidate[] {
  for (const c of list) for (const p of profiles) c.profiles.add(p.id);
  return list;
}

function fromElement(el: Element, source: CandidateSource, tag = el.tagName.toLowerCase()): RawCandidate | null {
  if (isSkipped(el)) return null;
  const text = elementText(el);
  if (text.length < 2) return null;
  return { el, text, tag, source, hints: NO_HINTS(), profiles: new Set() };
}

// --- structured_data ------------------------------------------------------

function walkJsonLd(node: unknown, out: Array<{ type: string; text: string; hints: CandidateHints }>, depth = 0): void {
  if (depth > 6 || node == null) return;
  if (Array.isArray(node)) {
    for (const n of node) walkJsonLd(n, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if (Array.isArray(o["@graph"])) walkJsonLd(o["@graph"], out, depth + 1);
  const type = typeof o["@type"] === "string" ? (o["@type"] as string) : Array.isArray(o["@type"]) ? String(o["@type"][0]) : "";
  if (type) {
    const parts: string[] = [];
    for (const key of ["name", "headline", "streetAddress", "addressLocality", "addressRegion", "postalCode", "addressCountry", "telephone", "email", "price", "startDate", "location"]) {
      const v = o[key];
      if (typeof v === "string" || typeof v === "number") parts.push(String(v));
      else if (v && typeof v === "object" && !Array.isArray(v)) {
        const inner = v as Record<string, unknown>;
        for (const k of ["name", "streetAddress", "addressLocality", "postalCode", "addressCountry"]) {
          if (typeof inner[k] === "string") parts.push(inner[k] as string);
        }
      }
    }
    const addr = o.address as Record<string, unknown> | undefined;
    if (addr && typeof addr === "object" && !Array.isArray(addr)) {
      for (const k of ["streetAddress", "addressLocality", "addressRegion", "postalCode", "addressCountry"]) {
        if (typeof addr[k] === "string") parts.push(addr[k] as string);
      }
    }
    const hints = NO_HINTS();
    const geo = (o.geo ?? (o.location as Record<string, unknown> | undefined)?.geo) as Record<string, unknown> | undefined;
    if (geo && typeof geo === "object") {
      const lat = Number(geo.latitude);
      const lng = Number(geo.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        hints.lat = lat;
        hints.lng = lng;
      }
    }
    if (typeof o["@id"] === "string" && /place|maps/.test(o["@id"] as string)) hints.placeId = o["@id"] as string;
    const text = cleanText(Array.from(new Set(parts)).join(", "));
    if (text.length >= 2) out.push({ type, text, hints });
  }
  for (const [k, v] of Object.entries(o)) {
    if (k.startsWith("@")) continue;
    if (v && typeof v === "object") walkJsonLd(v, out, depth + 1);
  }
}

const structuredData: Extractor = (profiles) => {
  const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'));
  const items: Array<{ type: string; text: string; hints: CandidateHints }> = [];
  for (const s of scripts) {
    try {
      walkJsonLd(JSON.parse(s.textContent ?? ""), items);
    } catch {
      // ignore malformed JSON-LD
    }
  }
  const out: RawCandidate[] = [];
  for (const item of items) {
    const c: RawCandidate = {
      el: null,
      text: item.text,
      tag: "ld+json",
      source: "structured_data",
      hints: item.hints,
      context: { heading: `JSON-LD ${item.type}` },
      profiles: new Set(),
    };
    for (const p of profiles) {
      const types = p.selection.structuredTypes ?? [];
      if (types.length === 0 || types.some((t) => t.toLowerCase() === item.type.toLowerCase())) c.profiles.add(p.id);
    }
    if (c.profiles.size) out.push(c);
  }
  return out;
};

// --- semantic_html --------------------------------------------------------

const semanticHtml: Extractor = (profiles) => {
  const els = document.querySelectorAll('address, [itemtype*="PostalAddress"], [itemprop="address"]');
  const out: RawCandidate[] = [];
  for (const el of Array.from(els)) {
    const c = fromElement(el, "semantic_html", "address");
    if (c) out.push(c);
  }
  return tagAll(out, profiles);
};

// --- map_embeds -----------------------------------------------------------

function coordsFromMapUrl(url: string): CandidateHints {
  const hints = NO_HINTS();
  const at = /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(url);
  const q = /[?&](?:q|ll|center)=(-?\d+\.\d+),(-?\d+\.\d+)/.exec(url);
  const osm = /mlat=(-?\d+\.\d+).*?mlon=(-?\d+\.\d+)/.exec(url) ?? /#map=\d+\/(-?\d+\.\d+)\/(-?\d+\.\d+)/.exec(url);
  const m = at ?? q ?? osm;
  if (m) {
    hints.lat = Number(m[1]);
    hints.lng = Number(m[2]);
  }
  const pid = /place_id[=:]([A-Za-z0-9_-]+)/.exec(url) ?? /!1s(0x[0-9a-f]+:0x[0-9a-f]+)/.exec(url);
  if (pid) hints.placeId = pid[1];
  return hints;
}

const mapEmbeds: Extractor = (profiles) => {
  const out: RawCandidate[] = [];
  const frames = document.querySelectorAll<HTMLIFrameElement>('iframe[src*="google.com/maps"], iframe[src*="openstreetmap"]');
  for (const f of Array.from(frames)) {
    if (isSkipped(f)) continue;
    const src = f.src;
    const hints = coordsFromMapUrl(src);
    const q = /[?&]q=([^&]+)/.exec(src);
    const text = cleanText(f.title || (q ? decodeURIComponent(q[1].replace(/\+/g, " ")) : "") || `Map embed ${src.slice(0, 120)}`);
    out.push({ el: f, text, tag: "iframe", source: "map_embeds", hints, profiles: new Set() });
  }
  const links = document.querySelectorAll<HTMLAnchorElement>('a[href*="maps.app.goo.gl"], a[href*="google.com/maps"], a[href*="openstreetmap.org"]');
  for (const a of Array.from(links)) {
    if (isSkipped(a)) continue;
    const hints = coordsFromMapUrl(a.href);
    const text = elementText(a) || cleanText(a.href, 200);
    out.push({ el: a, text, tag: "a", source: "map_embeds", hints, profiles: new Set() });
  }
  return tagAll(out, profiles);
};

// --- text_patterns --------------------------------------------------------

const DEFAULT_ADDRESS_PATTERNS = [
  // "66 Mint St, San Francisco, CA 94103"
  String.raw`\b\d{1,5}[A-Za-z]?\s+(?:[A-Z][\w'.-]*\s){0,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Place|Pl|Court|Ct|Square|Sq|Plaza|Terrace|Highway|Hwy|Straße|Strasse|Str\.?|Gasse|Platz|Weg|Allee)\b[^\n]{0,80}`,
  // Postal codes: US ZIP, UK, DE, CA
  String.raw`\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b|\b\d{5}(?:-\d{4})?\b|\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b`,
];

function textNodesUnder(root: Node): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest("script, style, noscript, template, nav, footer, [aria-hidden='true']")) return NodeFilter.FILTER_REJECT;
      if ((node as Text).data.trim().length < 3) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n: Node | null;
  while ((n = walker.nextNode())) out.push(n as Text);
  return out;
}

const textPatterns: Extractor = (profiles) => {
  const perProfile: Array<{ profile: CompiledProfile; regexes: RegExp[] }> = [];
  for (const p of profiles) {
    const sources = p.selection.textPatterns?.length ? p.selection.textPatterns : DEFAULT_ADDRESS_PATTERNS;
    const regexes: RegExp[] = [];
    for (const src of sources) {
      try {
        regexes.push(new RegExp(src, "g"));
      } catch {
        // invalid regex in profile; skip it
      }
    }
    if (regexes.length) perProfile.push({ profile: p, regexes });
  }
  if (!perProfile.length) return [];
  const out: RawCandidate[] = [];
  const seenPerElement = new Map<Element, Set<string>>();
  for (const node of textNodesUnder(document.body)) {
    const parent = node.parentElement!;
    if (isSkipped(parent)) continue;
    const text = node.data.replace(/\s+/g, " ");
    for (const { profile, regexes } of perProfile) {
      for (const re of regexes) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        let guard = 0;
        while ((m = re.exec(text)) && guard++ < 50) {
          const matched = cleanText(m[0], 300);
          if (matched.length < 3) continue;
          const seen = seenPerElement.get(parent) ?? new Set();
          seenPerElement.set(parent, seen);
          const key = normalizeText(matched);
          let existing = out.find((c) => c.el === parent && normalizeText(c.text) === key);
          if (!existing) {
            existing = { el: parent, text: matched, tag: parent.tagName.toLowerCase(), source: "text_patterns", hints: NO_HINTS(), profiles: new Set() };
            out.push(existing);
          }
          existing.profiles.add(profile.id);
          if (m[0].length === 0) re.lastIndex++;
        }
      }
    }
  }
  return out;
};

// --- headings, link_text, table_cells, list_items ----------------------------

const headings: Extractor = (profiles) => {
  const els = document.querySelectorAll("h1, h2, h3, strong, b, [role='heading']");
  const out: RawCandidate[] = [];
  for (const el of Array.from(els)) {
    const c = fromElement(el, "headings");
    if (c && c.text.length <= 200) out.push(c);
  }
  return tagAll(out, profiles);
};

const linkText: Extractor = (profiles) => {
  const els = document.querySelectorAll<HTMLAnchorElement>("a[href]");
  const out: RawCandidate[] = [];
  for (const a of Array.from(els)) {
    if (!externalHost(a.href)) continue;
    const c = fromElement(a, "link_text", "a");
    if (c && c.text.length <= 150) out.push(c);
  }
  return tagAll(out, profiles);
};

const tableCells: Extractor = (profiles) => {
  const els = document.querySelectorAll("td, th");
  const out: RawCandidate[] = [];
  for (const el of Array.from(els)) {
    const c = fromElement(el, "table_cells");
    if (c) out.push(c);
  }
  return tagAll(out, profiles);
};

const listItems: Extractor = (profiles) => {
  const els = document.querySelectorAll("li, dd");
  const out: RawCandidate[] = [];
  for (const el of Array.from(els)) {
    // Skip list items that are just containers for many blocks.
    if (el.querySelectorAll("li, p, div").length > 3) continue;
    const c = fromElement(el, "list_items");
    if (c) out.push(c);
  }
  return tagAll(out, profiles);
};

export const EXTRACTORS: { [K in CandidateSource]: Extractor } = {
  structured_data: structuredData,
  semantic_html: semanticHtml,
  map_embeds: mapEmbeds,
  text_patterns: textPatterns,
  headings,
  link_text: linkText,
  table_cells: tableCells,
  list_items: listItems,
};

/** Default priority order, used when trimming to maxCandidates. */
export const SOURCE_PRIORITY: CandidateSource[] = [
  "structured_data",
  "semantic_html",
  "map_embeds",
  "text_patterns",
  "headings",
  "link_text",
  "table_cells",
  "list_items",
];

function contextRichness(c: RawCandidate): number {
  return (c.context?.heading?.length ?? 0) + (c.hints.lat != null ? 100 : 0) + (c.el ? 10 : 0);
}

/**
 * Run the union of the active profiles' extractors once, tag each candidate with the
 * profiles it belongs to, dedupe by normalized text, and cap by maxCandidates.
 */
export function collectCandidates(profiles: CompiledProfile[]): Candidate[] {
  // Clear tags from a previous scan so ids never go stale.
  for (const el of Array.from(document.querySelectorAll("[data-geo-id]"))) el.removeAttribute("data-geo-id");

  const bySource = new Map<CandidateSource, CompiledProfile[]>();
  for (const p of profiles) {
    for (const s of p.selection.sources) {
      const list = bySource.get(s) ?? [];
      list.push(p);
      bySource.set(s, list);
    }
  }
  let raws: RawCandidate[] = [];
  for (const source of SOURCE_PRIORITY) {
    const owners = bySource.get(source);
    if (!owners?.length) continue;
    try {
      raws = raws.concat(EXTRACTORS[source](owners));
    } catch (err) {
      console.warn(`[page-extractor] extractor ${source} failed`, err);
    }
  }

  // Dedupe by normalized text; keep the richer one and merge profile tags.
  const byText = new Map<string, RawCandidate>();
  for (const c of raws) {
    const key = normalizeText(c.text);
    if (!key) continue;
    const existing = byText.get(key);
    if (!existing) {
      byText.set(key, c);
    } else {
      for (const pid of c.profiles) existing.profiles.add(pid);
      if (contextRichness(c) > contextRichness(existing)) {
        c.profiles = existing.profiles;
        byText.set(key, c);
      }
    }
  }

  // Cap: highest maxCandidates across active profiles, priority order by source.
  const cap = Math.max(...profiles.map((p) => p.selection.maxCandidates), 1);
  const contextChars = Math.max(...profiles.map((p) => p.selection.contextChars), 0);
  const ordered = Array.from(byText.values()).sort((a, b) => SOURCE_PRIORITY.indexOf(a.source) - SOURCE_PRIORITY.indexOf(b.source));
  const kept = ordered.slice(0, cap);

  const textIndex = contextChars > 0 ? buildTextIndex() : [];
  const out: Candidate[] = [];
  kept.forEach((raw, i) => {
    const id = `c${i + 1}`;
    let context: CandidateContext = { ...(raw.context ?? {}) };
    let domPath: string | undefined;
    if (raw.el) {
      // One element can carry several candidates (e.g. an address plus a postal code found
      // inside it); the attribute keeps the highest-priority one.
      if (!raw.el.hasAttribute("data-geo-id")) raw.el.setAttribute("data-geo-id", id);
      context.heading = context.heading ?? precedingHeading(raw.el);
      if (contextChars > 0) {
        const adj = adjacentText(raw.el, contextChars, textIndex);
        context = { ...context, ...adj };
      }
      domPath = cssPath(raw.el);
    }
    out.push({
      id,
      text: raw.text,
      tag: raw.tag,
      source: raw.source,
      context,
      hints: raw.hints,
      profiles: Array.from(raw.profiles),
      domPath,
    });
  });
  return out;
}
