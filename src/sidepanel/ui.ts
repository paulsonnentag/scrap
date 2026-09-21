/** Tiny DOM helpers so the panel has no framework dependency. */

type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Omit<HTMLElementTagNameMap[K], "style" | "children">> & { class?: string; style?: string; dataset?: Record<string, string>; on?: Record<string, (e: Event) => void> } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "class") el.className = v as string;
    else if (k === "style") el.setAttribute("style", v as string);
    else if (k === "dataset") for (const [dk, dv] of Object.entries(v as Record<string, string>)) el.dataset[dk] = dv;
    else if (k === "on") for (const [ev, fn] of Object.entries(v as Record<string, (e: Event) => void>)) el.addEventListener(ev, fn);
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function toast(message: string, ms = 2500): void {
  const t = document.getElementById("toast")!;
  t.textContent = message;
  t.hidden = false;
  window.clearTimeout((t as HTMLElement & { _timer?: number })._timer);
  (t as HTMLElement & { _timer?: number })._timer = window.setTimeout(() => (t.hidden = true), ms);
}

export function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

export function money(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
