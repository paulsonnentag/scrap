import { sendToBackground } from "../../shared/messages";
import { truthProbability } from "../../shared/jev";
import type { CompiledProfile, GeocodeResult, Match } from "../../shared/types";
import { notify, refreshPage, state } from "../state";
import { requestDiagnosis } from "./debug";
import { h, pct, toast } from "../ui";

function profileFor(id: string): CompiledProfile | undefined {
  return state.profiles.find((p) => p.id === id);
}

/** Apply the slider override to stored answers without calling Jev. */
function effectiveStatus(m: Match): Match["status"] | "discard" {
  if (m.status === "confirmed" || m.status === "rejected") return m.status;
  const profile = profileFor(m.profileId);
  const override = state.thresholdOverride[m.profileId];
  if (!profile || override === undefined) return m.status;
  const p = truthProbability(m.answers[profile.decision.acceptField]);
  if (p >= override) return "accepted";
  if (p >= profile.decision.reviewThreshold) return "review";
  return "discard";
}

function renderMatch(m: Match): HTMLElement {
  const profile = profileFor(m.profileId);
  const status = effectiveStatus(m);
  const p = profile ? truthProbability(m.answers[profile.decision.acceptField]) : 0;
  const geo = m.resolved?.geocode as GeocodeResult | null | undefined;
  const otherAnswers = Object.entries(m.answers).filter(([k]) => k !== profile?.decision.acceptField);
  const badgeClass = status === "accepted" || status === "confirmed" ? "ok" : status === "review" ? "warn" : "bad";

  return h(
    "div",
    { class: "card clickable", on: { click: () => void focus(m) } },
    h("div", { class: "row between" }, h("span", { class: "match-text" }, m.text), h("span", { class: `badge ${badgeClass}` }, status)),
    h(
      "div",
      { class: "row small muted" },
      h("span", { class: "prob" }, `p=${p.toFixed(2)}`),
      ...otherAnswers.map(([k, a]) => h("span", { class: "badge" }, `${k}: ${String(a.value)} (${pct(a.probability)})`)),
    ),
    geo
      ? h(
          "div",
          { class: "small" },
          `📍 ${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)} `,
          h("a", { href: `https://www.openstreetmap.org/?mlat=${geo.lat}&mlon=${geo.lng}#map=17/${geo.lat}/${geo.lng}`, target: "_blank", rel: "noreferrer" }, "map"),
          h("span", { class: "muted" }, ` · ${geo.displayName}${geo.verified ? " · verified" : ""}`),
        )
      : m.resolved && "geocode" in m.resolved
        ? h("div", { class: "small muted" }, "Geocoding found no confident match.")
        : null,
    status === "review"
      ? h(
          "div",
          { class: "row", style: "margin-top:6px" },
          h("button", { class: "sm primary", on: { click: (e) => void review(e, m, "confirmed") } }, "Confirm"),
          h("button", { class: "sm danger", on: { click: (e) => void review(e, m, "rejected") } }, "Reject"),
        )
      : null,
  );
}

async function focus(m: Match): Promise<void> {
  if (state.tabId == null) return;
  await chrome.tabs.sendMessage(state.tabId, { type: "FOCUS_MATCH", matchId: m.id, domPath: m.domPath }).catch(() => toast("Could not reach the page. Try rescanning."));
}

async function review(e: Event, m: Match, decision: "confirmed" | "rejected"): Promise<void> {
  e.stopPropagation();
  const res = await sendToBackground<{ ok: boolean }>({ type: "REVIEW", matchId: m.id, origin: state.origin, url: state.url, decision });
  if (res?.ok) {
    m.status = decision;
    notify();
  } else toast("This match isn't stored yet (test results can't be reviewed).");
}

async function rescan(btn: HTMLButtonElement): Promise<void> {
  if (state.tabId == null) return;
  btn.disabled = true;
  btn.textContent = "Scanning…";
  await sendToBackground({ type: "RESCAN", tabId: state.tabId }).catch(() => toast("Could not reach the page. Reload it and try again."));
  window.setTimeout(() => {
    btn.disabled = false;
    btn.textContent = "Rescan";
  }, 3000);
}

type PanelAsk = (typeof state.pendingAsks)[number];

async function answerAsk(ask: PanelAsk, allow: boolean): Promise<void> {
  await chrome.runtime.sendMessage({ type: "ASK_DECISION", profileId: ask.profileId, origin: ask.origin, allow, tabId: ask.tabId });
  state.pendingAsks = state.pendingAsks.filter((a) => a !== ask);
  notify();
  if (allow) window.setTimeout(() => void refreshPage(), 4000);
}

async function setOverride(profileId: string, mode: "always" | "never"): Promise<void> {
  await sendToBackground({ type: "SITE_OVERRIDE", profileId, origin: state.origin, mode });
  state.pendingAsks = state.pendingAsks.filter((a) => a.profileId !== profileId || a.origin !== state.origin);
  if (mode === "always" && state.tabId != null) await sendToBackground({ type: "RESCAN", tabId: state.tabId }).catch(() => undefined);
  notify();
}

export function renderPageTab(root: HTMLElement): void {
  if (!state.hasKey || !state.settings?.onboarded) {
    root.append(
      h(
        "div",
        { class: "card" },
        h("p", {}, h("b", {}, "Set up Page Extractor")),
        h("p", { class: "muted" }, "Add your OpenRouter key and pick a profile in Settings. Nothing is scanned until setup is complete."),
        h("button", { class: "primary", on: { click: () => document.querySelector<HTMLButtonElement>('[data-tab="settings"]')?.click() } }, "Open Settings"),
      ),
    );
    return;
  }
  root.append(
    h(
      "div",
      { class: "row between" },
      h("div", { class: "small muted mono", style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70%" }, state.url || "(no page)"),
      h(
        "div",
        { class: "row" },
        h("button", { class: "sm", title: "Build a pasteable report explaining what this scan did", on: { click: () => requestDiagnosis() } }, "Diagnose"),
        h("button", { class: "sm", on: { click: (e) => void rescan(e.currentTarget as HTMLButtonElement) } }, "Rescan"),
      ),
    ),
  );

  for (const ask of state.pendingAsks.filter((a) => a.origin === state.origin)) {
    root.append(
      h(
        "div",
        { class: "card" },
        h("p", {}, `Run "${ask.profileName}" on ${ask.origin}?`),
        h(
          "div",
          { class: "row" },
          h("button", { class: "sm primary", on: { click: () => void answerAsk(ask, true) } }, "This time"),
          h("button", { class: "sm", on: { click: () => void answerAsk(ask, false) } }, "Not now"),
          h("button", { class: "sm", on: { click: () => void setOverride(ask.profileId, "always") } }, "Always here"),
          h("button", { class: "sm", on: { click: () => void setOverride(ask.profileId, "never") } }, "Never here"),
        ),
      ),
    );
  }

  const s = state.summary;
  if (s?.error) root.append(h("p", { class: "err small" }, `Scan failed: ${s.error}`));
  if (s?.skipped) root.append(h("p", { class: "muted small" }, `Not scanned: ${s.skipped}.`));
  if (s && !s.skipped) root.append(h("p", { class: "muted small" }, `${s.candidates} candidates · ${s.requests} Jev request${s.requests === 1 ? "" : "s"} · ${new Date(s.scannedAt).toLocaleTimeString()}`));

  const visible = state.matches.filter((m) => effectiveStatus(m) !== "discard");
  if (!visible.length) {
    if (!s?.skipped && !s?.error) root.append(h("p", { class: "muted" }, "No matches on this page yet."));
    root.append(
      h(
        "div",
        { class: "card" },
        h("p", { class: "small" }, "Nothing to show for this page."),
        h("p", { class: "small muted" }, "Generate a debug report to see which profiles were considered, what the extractors found, and what Jev answered."),
        h("button", { class: "primary sm", on: { click: () => requestDiagnosis() } }, "Explain why"),
      ),
    );
    return;
  }

  const byProfile = new Map<string, Match[]>();
  for (const m of visible) {
    if (!byProfile.has(m.profileId)) byProfile.set(m.profileId, []);
    byProfile.get(m.profileId)!.push(m);
  }

  const order = { confirmed: 0, accepted: 1, review: 2, rejected: 3, discard: 4 } as const;
  for (const [pid, matches] of byProfile) {
    const profile = profileFor(pid);
    const threshold = state.thresholdOverride[pid] ?? profile?.decision.acceptThreshold ?? 0.85;
    root.append(h("h2", {}, profile?.name ?? pid, " ", h("span", { class: "badge" }, String(matches.length))));
    if (profile) {
      const label = h("span", { class: "prob" }, `accept ≥ ${threshold.toFixed(2)}`);
      root.append(
        h(
          "div",
          { class: "slider small" },
          h("span", { class: "muted" }, "Threshold"),
          h("input", {
            type: "range",
            min: "0",
            max: "1",
            step: "0.01",
            value: String(threshold),
            on: {
              input: (e) => {
                const v = Number((e.target as HTMLInputElement).value);
                state.thresholdOverride[pid] = v;
                label.textContent = `accept ≥ ${v.toFixed(2)}`;
                notify();
              },
            },
          }),
          label,
        ),
      );
    }
    for (const m of matches.sort((a, b) => order[effectiveStatus(a)] - order[effectiveStatus(b)])) root.append(renderMatch(m));
  }
}
