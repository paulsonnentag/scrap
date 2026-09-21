import { sendToBackground } from "../../shared/messages";
import type { ExtractionDoc, GeocodeResult, Match } from "../../shared/types";
import { state } from "../state";
import { clear, download, fmtDate, h, toast } from "../ui";

type Sizes = Record<string, { bytes: number; pages: number; matches: number }>;

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function flatten(doc: ExtractionDoc, profileName: (id: string) => string, acceptField: (id: string) => string | undefined): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const [url, page] of Object.entries(doc.pages ?? {})) {
    for (const m of page.matches) {
      const geo = m.resolved?.geocode as GeocodeResult | null | undefined;
      const field = acceptField(m.profileId);
      rows.push({
        origin: doc.origin,
        url,
        page_title: page.title,
        profile: profileName(m.profileId),
        text: m.text,
        status: m.status,
        probability: field ? m.answers[field]?.probability : undefined,
        lat: geo?.lat,
        lng: geo?.lng,
        display_name: geo?.displayName,
        model: m.model,
        updated_at: m.updatedAt,
        answers: JSON.stringify(m.answers),
      });
    }
  }
  return rows;
}

export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvEscape(r[c])).join(","))].join("\n");
}

async function loadDoc(origin: string): Promise<ExtractionDoc | undefined> {
  const res = await sendToBackground<{ doc?: ExtractionDoc }>({ type: "GET_ORIGIN_DOC", origin }).catch(() => undefined);
  return res?.doc;
}

async function exportAll(format: "json" | "csv", sizes: Sizes): Promise<void> {
  const docs: ExtractionDoc[] = [];
  for (const origin of Object.keys(sizes)) {
    const d = await loadDoc(origin);
    if (d) docs.push(d);
  }
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "json") {
    download(`page-extractor-${stamp}.json`, JSON.stringify(docs, null, 2), "application/json");
  } else {
    const name = (id: string) => state.profiles.find((p) => p.id === id)?.name ?? id;
    const field = (id: string) => state.profiles.find((p) => p.id === id)?.decision.acceptField;
    download(`page-extractor-${stamp}.csv`, toCsv(docs.flatMap((d) => flatten(d, name, field))), "text/csv");
  }
}

function renderMatchRow(m: Match): HTMLElement {
  const geo = m.resolved?.geocode as GeocodeResult | null | undefined;
  return h(
    "tr",
    {},
    h("td", {}, m.text),
    h("td", {}, h("span", { class: `badge ${m.status === "rejected" ? "bad" : m.status === "review" ? "warn" : "ok"}` }, m.status)),
    h("td", { class: "small muted" }, geo ? `${geo.lat.toFixed(4)}, ${geo.lng.toFixed(4)}` : ""),
  );
}

export function renderDataTab(root: HTMLElement): void {
  const container = h("div", {}, h("span", { class: "spinner" }));
  root.append(container);
  void (async () => {
    const res = await sendToBackground<{ sizes: Sizes }>({ type: "GET_DATA_INDEX" }).catch(() => undefined);
    const sizes = res?.sizes ?? {};
    const origins = Object.keys(sizes).sort();
    clear(container);
    const total = origins.reduce((n, o) => n + sizes[o].bytes, 0);
    container.append(
      h(
        "div",
        { class: "row between" },
        h("span", { class: "muted small" }, `${origins.length} site${origins.length === 1 ? "" : "s"} · ${(total / 1024).toFixed(1)} KB in Automerge`),
        h(
          "div",
          { class: "row" },
          h("button", { class: "sm", disabled: !origins.length, on: { click: () => void exportAll("json", sizes) } }, "Export JSON"),
          h("button", { class: "sm", disabled: !origins.length, on: { click: () => void exportAll("csv", sizes) } }, "Export CSV"),
        ),
      ),
    );
    if (!origins.length) {
      container.append(h("p", { class: "muted" }, "No stored matches yet."));
      return;
    }
    for (const origin of origins) {
      const s = sizes[origin];
      const body = h("div", {});
      const details = h(
        "details",
        {
          on: {
            toggle: async (e) => {
              if (!(e.target as HTMLDetailsElement).open || body.childElementCount) return;
              body.append(h("span", { class: "spinner" }));
              const doc = await loadDoc(origin);
              clear(body);
              if (!doc) {
                body.append(h("p", { class: "muted" }, "Could not load."));
                return;
              }
              const pages = Object.entries(doc.pages ?? {}).sort((a, b) => b[1].lastSeen.localeCompare(a[1].lastSeen));
              for (const [url, page] of pages) {
                body.append(
                  h(
                    "div",
                    { class: "card" },
                    h("div", { class: "small" }, h("b", {}, page.title || url)),
                    h("div", { class: "small muted mono", style: "word-break:break-all" }, url),
                    h("div", { class: "small muted" }, `first seen ${fmtDate(page.firstSeen)} · last ${fmtDate(page.lastSeen)}`),
                    h("table", {}, ...page.matches.map(renderMatchRow)),
                  ),
                );
              }
            },
          },
        },
        h("summary", {}, origin, " ", h("span", { class: "badge" }, `${s.matches} matches`), " ", h("span", { class: "badge" }, `${s.pages} pages`), " ", h("span", { class: "badge" }, `${(s.bytes / 1024).toFixed(1)} KB`)),
        h(
          "div",
          { class: "row", style: "margin:6px 0" },
          h(
            "button",
            {
              class: "sm danger",
              on: {
                click: async () => {
                  if (!confirm(`Delete all stored matches for ${origin}?`)) return;
                  await sendToBackground({ type: "CLEAR_SITE", origin });
                  toast("Site cleared");
                  clear(root);
                  renderDataTab(root);
                },
              },
            },
            "Clear site",
          ),
        ),
        body,
      );
      container.append(details);
    }
    container.append(
      h("hr", { style: "border:0;border-top:1px solid var(--border);margin:14px 0" }),
      h(
        "button",
        {
          class: "danger",
          on: {
            click: async () => {
              if (!confirm("Delete ALL stored matches and caches? Your API key and settings are kept.")) return;
              await sendToBackground({ type: "CLEAR_ALL" });
              toast("All data cleared");
              clear(root);
              renderDataTab(root);
            },
          },
        },
        "Clear all",
      ),
    );
  })();
}
