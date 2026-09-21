/**
 * Diagnostics UI: generates a single pasteable report describing the last scan of the
 * active tab, why it stopped where it did, and the page source the extractors saw.
 */
import { renderDebugReport, type DebugReport } from "../../shared/debug";
import { sendToBackground } from "../../shared/messages";
import { state } from "../state";
import { clear, download, h, toast } from "../ui";

interface Options {
  includeSource: boolean;
  raw: boolean;
  maxSourceChars: number;
}

const options: Options = { includeSource: true, raw: false, maxSourceChars: 200_000 };
let lastReport: { report: DebugReport; markdown: string } | undefined;
let pendingAutoRun = false;

/** Called from the This page tab: switch to Settings and generate immediately. */
export function requestDiagnosis(): void {
  pendingAutoRun = true;
  document.querySelector<HTMLButtonElement>('[data-tab="settings"]')?.click();
}

async function generate(container: HTMLElement, btn?: HTMLButtonElement): Promise<void> {
  if (state.tabId == null) return void toast("No active tab.");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Collecting…";
  }
  try {
    const res = await sendToBackground<{ report?: DebugReport; error?: string }>({
      type: "GET_DEBUG",
      tabId: state.tabId,
      includeSource: options.includeSource,
      raw: options.raw,
      maxSourceChars: options.maxSourceChars,
    });
    if (!res?.report) throw new Error(res?.error ?? "no report returned");
    lastReport = { report: res.report, markdown: renderDebugReport(res.report) };
    renderResult(container);
  } catch (err) {
    clear(container);
    container.append(h("p", { class: "err small" }, `Could not build the report: ${(err as Error).message}`));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Generate report";
    }
  }
}

async function copy(markdown: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(markdown);
    toast(`Copied ${Math.round(markdown.length / 1024)} KB. Paste it back to Claude.`);
  } catch {
    // Clipboard API can be blocked; fall back to a hidden textarea.
    const ta = h("textarea", { value: markdown, style: "position:fixed;left:-9999px;top:0" });
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    toast(ok ? "Copied to clipboard." : "Copy failed. Use Download instead.");
  }
}

function renderResult(container: HTMLElement): void {
  clear(container);
  if (!lastReport) return;
  const { report, markdown } = lastReport;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  container.append(
    h("h3", {}, "Verdict"),
    h("div", { class: "card" }, ...report.diagnosis.map((d, i) => h("p", { class: "small", style: i === 0 ? "font-weight:600" : "" }, `${i + 1}. ${d}`))),
    h(
      "div",
      { class: "row" },
      h("button", { class: "primary", on: { click: () => void copy(markdown) } }, "Copy report"),
      h("button", { on: { click: () => download(`page-extractor-debug-${stamp}.md`, markdown, "text/markdown") } }, "Download .md"),
      report.pageSource.html ? h("button", { on: { click: () => download(`page-source-${stamp}.html`, report.pageSource.html!, "text/html") } }, "Page source only") : null,
    ),
    h(
      "p",
      { class: "small muted" },
      `${Math.round(markdown.length / 1024)} KB · page source ${report.pageSource.available ? `${(report.pageSource.bytesIncluded ?? 0).toLocaleString()} of ${(report.pageSource.bytesOriginal ?? 0).toLocaleString()} chars${report.pageSource.truncated ? ", truncated" : ""}` : "not captured"}. API keys are stripped, but the report contains this page's URL and content, so read it before sharing.`,
    ),
    h("details", {}, h("summary", { class: "small" }, "Preview"), h("pre", { class: "mono", style: "white-space:pre-wrap;word-break:break-word;max-height:300px;overflow:auto;font-size:11px" }, markdown.slice(0, 4000) + (markdown.length > 4000 ? "\n… truncated in this preview; the copied report is complete." : ""))),
  );
}

export function renderDebugSection(root: HTMLElement): void {
  const results = h("div", {});
  const genBtn = h("button", { class: "primary", on: { click: (e) => void generate(results, e.currentTarget as HTMLButtonElement) } }, "Generate report");

  root.append(
    h("h2", {}, "Diagnostics"),
    h("p", { class: "small muted" }, "Builds one pasteable report: what the last scan did on the active tab, where it stopped, every Jev request and the raw answers it got back, and the page source the extractors saw."),
    h(
      "div",
      { class: "stack" },
      h("label", { class: "inline" }, h("input", { type: "checkbox", checked: options.includeSource, on: { change: (e) => (options.includeSource = (e.target as HTMLInputElement).checked) } }), "Include page source"),
      h("label", { class: "inline" }, h("input", { type: "checkbox", checked: options.raw, on: { change: (e) => (options.raw = (e.target as HTMLInputElement).checked) } }), "Keep script and style bodies (larger, may contain tokens)"),
      h(
        "label",
        { class: "field small" },
        h("span", {}, "Source size limit"),
        h(
          "select",
          { on: { change: (e) => (options.maxSourceChars = Number((e.target as HTMLSelectElement).value)) } },
          h("option", { value: "50000" }, "50k characters"),
          h("option", { value: "200000", selected: true }, "200k characters"),
          h("option", { value: "1000000" }, "1M characters"),
        ),
      ),
    ),
    h("div", { class: "row" }, genBtn, h("button", { class: "sm", on: { click: () => void sendToBackground({ type: "CLEAR_DEBUG" }).then(() => toast("Debug log cleared")) } }, "Clear log")),
    results,
  );

  if (lastReport) renderResult(results);
  if (pendingAutoRun) {
    pendingAutoRun = false;
    void generate(results, genBtn);
  }
}
