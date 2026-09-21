import { normalizeText } from "../shared/hash";

const SKIP_ANCESTORS = "nav, footer, script, style, noscript, template, [aria-hidden='true']";

export function isSkipped(el: Element): boolean {
  if (el.closest(SKIP_ANCESTORS)) return true;
  if (!(el instanceof HTMLElement)) return el.tagName.toLowerCase() === "script";
  if (el.hidden) return true;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    // Zero-size elements are skipped, but allow inline elements whose children may render.
    if (!el.getClientRects().length) return true;
  }
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return true;
  return false;
}

export function cleanText(text: string | null | undefined, cap = 300): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > cap ? t.slice(0, cap) : t;
}

export function elementText(el: Element, cap = 300): string {
  const raw = (el as HTMLElement).innerText ?? el.textContent;
  return cleanText(raw, cap);
}

/** Nearest preceding heading in document order. */
export function precedingHeading(el: Element): string | undefined {
  const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']"));
  let best: Element | undefined;
  for (const h of headings) {
    if (h === el || h.contains(el)) break;
    const pos = h.compareDocumentPosition(el);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) best = h;
    else break;
  }
  return best ? cleanText(elementText(best), 120) || undefined : undefined;
}

/** Visible text nodes in document order, computed once per scan. */
export type TextIndex = Text[];

export function buildTextIndex(root: Node = document.body): TextIndex {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest("script, style, noscript, template")) return NodeFilter.FILTER_REJECT;
      if (!(node as Text).data.trim()) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node: Node | null;
  while ((node = walker.nextNode())) out.push(node as Text);
  return out;
}

/**
 * Up to `chars` characters of visible text immediately before/after the element,
 * using the precomputed text index.
 */
export function adjacentText(el: Element, chars: number, index: TextIndex): { before?: string; after?: string } {
  if (chars <= 0 || !index.length) return {};
  let first = -1;
  let last = -1;
  for (let i = 0; i < index.length; i++) {
    if (el.contains(index[i])) {
      if (first === -1) first = i;
      last = i;
    } else if (first !== -1) {
      break;
    }
  }
  if (first === -1) {
    // Element has no text nodes (e.g. iframe): locate by document position.
    for (let i = 0; i < index.length; i++) {
      if (el.compareDocumentPosition(index[i]) & Node.DOCUMENT_POSITION_FOLLOWING) {
        first = i;
        last = i - 1;
        break;
      }
    }
    if (first === -1) {
      first = index.length;
      last = index.length - 1;
    }
  }
  let before = "";
  for (let i = first - 1; i >= 0 && before.length < chars; i--) before = index[i].data + " " + before;
  before = cleanText(before, 100_000);
  if (before.length > chars) before = before.slice(before.length - chars);
  let after = "";
  for (let i = last + 1; i < index.length && after.length < chars; i++) after += " " + index[i].data;
  after = cleanText(after, chars);
  return { before: before || undefined, after: after || undefined };
}

/** A CSS path for re-highlighting on later visits. Prefers IDs, falls back to nth-of-type chains. */
export function cssPath(el: Element): string {
  if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && document.querySelectorAll(`#${el.id}`).length === 1) {
    return `#${el.id}`;
  }
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.documentElement) {
    const tag = cur.tagName.toLowerCase();
    if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) {
      parts.unshift(`#${cur.id}`);
      break;
    }
    const parent: Element | null = cur.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const siblings = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
    const idx = siblings.indexOf(cur) + 1;
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
    cur = parent;
  }
  return parts.join(" > ");
}

export function externalHost(href: string): boolean {
  try {
    const u = new URL(href, location.href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return u.hostname !== location.hostname;
  } catch {
    return false;
  }
}

export { normalizeText };
