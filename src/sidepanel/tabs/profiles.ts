import { sendToBackground } from "../../shared/messages";
import { patternForOrigin } from "../../shared/matchPatterns";
import { requestHostPermission } from "../permissions";
import { validateCompiledProfile } from "../../shared/schema";
import type { CompiledProfile, JevQuestionTemplate, ResolverConfig, SiteOverrideMode, UserProfile } from "../../shared/types";
import { newId } from "../../shared/hash";
import { notify, refreshProfiles, state } from "../state";
import { clear, h, toast } from "../ui";

let editing: { compiled?: CompiledProfile; user: UserProfile; warnings: string[]; dirty: boolean } | null = null;

function emptyUser(): UserProfile {
  return { name: "", extract: "", matchPatterns: [], resolvers: [] };
}

function userFromCompiled(p: CompiledProfile): UserProfile {
  return {
    id: p.id,
    name: p.name,
    extract: p.source?.extract ?? "",
    matchPatterns: [...p.scope.matchPatterns],
    pageTypeHint: p.source?.pageTypeHint,
    resolvers: JSON.parse(JSON.stringify(p.resolvers)) as ResolverConfig[],
  };
}

export function openEditor(p?: CompiledProfile): void {
  editing = { compiled: p ? (JSON.parse(JSON.stringify(p)) as CompiledProfile) : undefined, user: p ? userFromCompiled(p) : emptyUser(), warnings: [], dirty: false };
  notify();
}

function closeEditor(): void {
  editing = null;
  notify();
}

// --- List -----------------------------------------------------------------------

async function toggle(p: CompiledProfile, enabled: boolean): Promise<void> {
  await sendToBackground({ type: "TOGGLE_PROFILE", profileId: p.id, enabled });
  await refreshProfiles();
}

async function setOverride(p: CompiledProfile, mode: SiteOverrideMode | null): Promise<void> {
  if (!state.origin) return;
  if (mode === "always") await requestHostPermission([patternForOrigin(state.origin)]);
  await sendToBackground({ type: "SITE_OVERRIDE", profileId: p.id, origin: state.origin, mode });
  await refreshProfiles();
  if (mode === "always" && state.tabId != null) await sendToBackground({ type: "RESCAN", tabId: state.tabId }).catch(() => undefined);
}

async function duplicate(p: CompiledProfile): Promise<void> {
  const copy: CompiledProfile = JSON.parse(JSON.stringify(p));
  copy.id = newId("p");
  copy.name = `${p.name} (copy)`;
  copy.builtin = false;
  copy.enabled = false;
  copy.version = 1;
  copy.scope.siteOverrides = {};
  await sendToBackground({ type: "SAVE_PROFILE", profile: copy });
  await refreshProfiles();
  toast("Profile duplicated");
}

async function remove(p: CompiledProfile): Promise<void> {
  if (!confirm(`Delete profile "${p.name}"? Stored matches are kept.`)) return;
  await sendToBackground({ type: "DELETE_PROFILE", profileId: p.id });
  await refreshProfiles();
}

function renderProfileCard(p: CompiledProfile): HTMLElement {
  const override = state.origin ? p.scope.siteOverrides?.[state.origin] : undefined;
  const select = h(
    "select",
    { on: { change: (e) => void setOverride(p, ((e.target as HTMLSelectElement).value || null) as SiteOverrideMode | null) } },
    h("option", { value: "" }, "Default (patterns)"),
    h("option", { value: "always" }, "Always run here"),
    h("option", { value: "never" }, "Never run here"),
    h("option", { value: "ask" }, "Ask each time"),
  );
  select.value = override ?? "";
  return h(
    "div",
    { class: "card" },
    h(
      "div",
      { class: "row between" },
      h("div", {}, h("b", {}, p.name), " ", p.builtin ? h("span", { class: "badge" }, "built-in") : null, p.customized ? h("span", { class: "badge accent" }, "customized") : null),
      h("label", { class: "inline" }, h("input", { type: "checkbox", checked: p.enabled, on: { change: (e) => void toggle(p, (e.target as HTMLInputElement).checked) } }), "Enabled"),
    ),
    h("div", { class: "small muted" }, p.source?.extract ?? `${p.questions.length} question${p.questions.length === 1 ? "" : "s"}`),
    h("div", { class: "small muted mono" }, p.scope.matchPatterns.length ? p.scope.matchPatterns.join("  ") : "no match patterns"),
    state.origin ? h("label", { class: "field small" }, h("span", {}, `On ${state.origin}`), select) : null,
    h(
      "div",
      { class: "row", style: "margin-top:6px" },
      h("button", { class: "sm", on: { click: () => openEditor(p) } }, "Edit"),
      h("button", { class: "sm", on: { click: () => void duplicate(p) } }, "Duplicate"),
      p.builtin ? null : h("button", { class: "sm danger", on: { click: () => void remove(p) } }, "Delete"),
    ),
  );
}

// --- Editor -------------------------------------------------------------------------

function resolverEditor(u: UserProfile, rerender: () => void): HTMLElement {
  const has = (t: ResolverConfig["type"]) => u.resolvers.find((r) => r.type === t);
  const setResolver = (t: ResolverConfig["type"], on: boolean, config: Record<string, unknown> = {}) => {
    u.resolvers = u.resolvers.filter((r) => r.type !== t);
    if (on) u.resolvers.push({ type: t, when: { field: "" }, config });
    if (editing) editing.dirty = true;
    rerender();
  };
  const geo = has("geocode");
  const hook = has("webhook");
  return h(
    "div",
    { class: "stack" },
    h("label", { class: "inline" }, h("input", { type: "checkbox", checked: !!geo, on: { change: (e) => setResolver("geocode", (e.target as HTMLInputElement).checked, { provider: "nominatim", verify: true }) } }), "Geocode to lat/lng"),
    geo
      ? h(
          "div",
          { style: "padding-left:20px" },
          h("label", { class: "inline small" }, h("input", { type: "checkbox", checked: geo.config.verify !== false, on: { change: (e) => ((geo.config.verify = (e.target as HTMLInputElement).checked), (editing!.dirty = true)) } }), "Verify result with Jev"),
          h("label", { class: "field small" }, h("span", {}, "Country bias (ISO code, optional)"), h("input", { type: "text", value: (geo.config.countryBias as string) ?? "", placeholder: "us", on: { input: (e) => ((geo.config.countryBias = (e.target as HTMLInputElement).value || undefined), (editing!.dirty = true)) } })),
        )
      : null,
    h("label", { class: "inline" }, h("input", { type: "checkbox", checked: !!hook, on: { change: (e) => setResolver("webhook", (e.target as HTMLInputElement).checked, { url: "" }) } }), "POST matches to a webhook"),
    hook
      ? h("div", { style: "padding-left:20px" }, h("label", { class: "field small" }, h("span", {}, "Webhook URL"), h("input", { type: "url", value: (hook.config.url as string) ?? "", placeholder: "https://…", on: { input: (e) => ((hook.config.url = (e.target as HTMLInputElement).value), (editing!.dirty = true)) } })))
      : null,
    h("label", { class: "inline" }, h("input", { type: "checkbox", checked: !!has("none"), on: { change: (e) => setResolver("none", (e.target as HTMLInputElement).checked) } }), "Store only"),
  );
}

function questionEditor(q: JevQuestionTemplate, onEdit: () => void): HTMLElement {
  const critRows = Object.entries(q.criteria).map(([k, v]) =>
    h("div", { class: "crit" }, h("span", { class: "k" }, k), h("textarea", { value: v, style: "min-height:34px", on: { input: (e) => ((q.criteria[k] = (e.target as HTMLTextAreaElement).value), onEdit()) } })),
  );
  return h(
    "div",
    { class: "qcard" },
    h("div", { class: "row between small" }, h("span", { class: "mono" }, q.id), h("span", { class: "badge" }, q.type)),
    h("textarea", { value: q.instructions, style: "min-height:44px;margin-top:4px", on: { input: (e) => ((q.instructions = (e.target as HTMLTextAreaElement).value), onEdit()) } }),
    ...critRows,
  );
}

async function compile(btn: HTMLButtonElement): Promise<void> {
  if (!editing) return;
  const u = editing.user;
  if (!u.name.trim() || !u.extract.trim()) return toast("Name and “What to extract” are required.");
  btn.disabled = true;
  const spinner = h("span", { class: "spinner", style: "margin-left:6px" });
  btn.after(spinner);
  try {
    const res = await sendToBackground<{ type: string; compiled?: CompiledProfile; warnings?: string[]; error?: string }>({ type: "COMPILE_PROFILE", profile: u });
    if (res?.compiled) {
      editing.compiled = res.compiled;
      editing.warnings = res.warnings ?? [];
      editing.dirty = false;
      toast("Compiled");
    } else toast(res?.error ?? "Compile failed");
  } catch (err) {
    toast((err as Error).message);
  } finally {
    btn.disabled = false;
    spinner.remove();
    notify();
  }
}

async function testOnPage(): Promise<void> {
  if (!editing?.compiled || state.tabId == null) return;
  const v = validateCompiledProfile(editing.compiled);
  if (!v.ok) return toast(v.errors[0]);
  await sendToBackground({ type: "TEST_PROFILE", compiled: editing.compiled, tabId: state.tabId });
  toast("Testing on this page… results appear in “This page”.");
  document.querySelector<HTMLButtonElement>('[data-tab="page"]')?.click();
}

async function save(): Promise<void> {
  if (!editing) return;
  const u = editing.user;
  if (!editing.compiled) return toast("Compile the profile first.");
  const p = editing.compiled;
  p.name = u.name;
  p.scope.matchPatterns = [...u.matchPatterns];
  p.source = { ...u, id: p.id };
  if (editing.dirty && p.compiler.model !== "builtin") {
    // The user edited fields after compiling: keep the compiled questions but reflect the edits.
    p.resolvers = u.resolvers.map((r) => ({ ...r, when: p.resolvers.find((x) => x.type === r.type)?.when ?? { field: p.decision.acceptField } }));
  }
  const v = validateCompiledProfile(p);
  if (!v.ok) return toast(v.errors[0]);
  if (u.matchPatterns.length) await requestHostPermission(u.matchPatterns);
  await sendToBackground({ type: "SAVE_PROFILE", profile: v.profile! });
  await refreshProfiles();
  toast("Saved");
  closeEditor();
}

function renderEditor(root: HTMLElement): void {
  const ed = editing!;
  const u = ed.user;
  const rerender = () => {
    clear(root);
    renderEditor(root);
  };
  const markCustomized = () => {
    if (ed.compiled) ed.compiled.customized = true;
  };

  const patternList = h("div", { class: "list-input" });
  const renderPatterns = () => {
    clear(patternList);
    u.matchPatterns.forEach((mp, i) => {
      patternList.append(
        h(
          "div",
          { class: "row" },
          h("input", { type: "text", value: mp, class: "mono", on: { input: (e) => ((u.matchPatterns[i] = (e.target as HTMLInputElement).value), (ed.dirty = true)) } }),
          h("button", { class: "sm", on: { click: () => { u.matchPatterns.splice(i, 1); ed.dirty = true; renderPatterns(); } } }, "✕"),
        ),
      );
    });
    patternList.append(
      h(
        "div",
        { class: "row" },
        h("button", { class: "sm", on: { click: () => { u.matchPatterns.push("*://*/*"); ed.dirty = true; renderPatterns(); } } }, "Add pattern"),
        state.origin ? h("button", { class: "sm", on: { click: () => { u.matchPatterns.push(patternForOrigin(state.origin)); ed.dirty = true; renderPatterns(); } } }, "Add current site") : null,
      ),
    );
  };
  renderPatterns();

  root.append(
    h("div", { class: "row between" }, h("h2", {}, ed.compiled?.id ? "Edit profile" : "New profile"), h("button", { class: "sm", on: { click: closeEditor } }, "Cancel")),
    h("label", { class: "field" }, h("span", {}, "Name"), h("input", { type: "text", value: u.name, placeholder: "Restaurant locations", on: { input: (e) => ((u.name = (e.target as HTMLInputElement).value), (ed.dirty = true)) } })),
    h(
      "label",
      { class: "field" },
      h("span", {}, "What to extract"),
      h("textarea", { value: u.extract, placeholder: "Physical addresses and restaurant or cafe names. Include branch locations if the page lists several. Ignore the company's HQ mailing address.", on: { input: (e) => ((u.extract = (e.target as HTMLTextAreaElement).value), (ed.dirty = true)) } }),
    ),
    h("div", { class: "field" }, h("span", { style: "font-weight:600;display:block;margin-bottom:3px" }, "Where it applies"), h("p", { class: "small muted", style: "margin-top:0" }, "Match patterns like *://*.yelp.com/* or *://*/locations*. With no patterns, the profile runs nowhere until you enable it for a site."), patternList),
    h("label", { class: "field" }, h("span", {}, "Page-type hint (optional)"), h("input", { type: "text", value: u.pageTypeHint ?? "", placeholder: "pages that list multiple venues", on: { input: (e) => ((u.pageTypeHint = (e.target as HTMLInputElement).value || undefined), (ed.dirty = true)) } })),
    h("div", { class: "field" }, h("span", { style: "font-weight:600;display:block;margin-bottom:3px" }, "What to do with matches"), resolverEditor(u, rerender)),
    h("div", { class: "row" }, h("button", { class: "primary", on: { click: (e) => void compile(e.currentTarget as HTMLButtonElement) } }, ed.compiled ? "Recompile" : "Compile"), ed.compiled?.customized ? h("span", { class: "small muted" }, "Recompiling replaces your edited questions.") : null),
  );

  if (ed.warnings.length) root.append(h("div", { class: "card" }, ...ed.warnings.map((w) => h("div", { class: "small", style: "color:var(--warn)" }, `⚠ ${w}`))));

  if (ed.compiled) {
    const c = ed.compiled;
    root.append(
      h(
        "details",
        { open: true },
        h("summary", {}, `Compiled questions (${c.questions.length})`, c.customized ? h("span", { class: "badge accent", style: "margin-left:6px" }, "customized") : null),
        h("p", { class: "small muted" }, `Sources: ${c.selection.sources.join(", ")} · accept ≥ ${c.decision.acceptThreshold} · review ≥ ${c.decision.reviewThreshold}${c.scope.pageGate ? " · page gate" : ""} · compiled by ${c.compiler.model}`),
        ...c.questions.map((q) => questionEditor(q, () => (markCustomized(), void 0))),
        c.scope.pageGate ? h("div", { class: "qcard" }, h("div", { class: "small muted" }, "Page gate"), h("textarea", { value: c.scope.pageGate.instructions, style: "min-height:44px", on: { input: (e) => ((c.scope.pageGate!.instructions = (e.target as HTMLTextAreaElement).value), markCustomized()) } })) : null,
        h(
          "div",
          { class: "row small", style: "margin-top:8px" },
          h("label", { class: "inline" }, "Accept ≥", h("input", { type: "number", min: "0", max: "1", step: "0.01", value: String(c.decision.acceptThreshold), style: "width:70px", on: { input: (e) => ((c.decision.acceptThreshold = Number((e.target as HTMLInputElement).value)), markCustomized()) } })),
          h("label", { class: "inline" }, "Review ≥", h("input", { type: "number", min: "0", max: "1", step: "0.01", value: String(c.decision.reviewThreshold), style: "width:70px", on: { input: (e) => ((c.decision.reviewThreshold = Number((e.target as HTMLInputElement).value)), markCustomized()) } })),
        ),
      ),
      h("div", { class: "row", style: "margin-top:10px" }, h("button", { on: { click: () => void testOnPage() }, disabled: state.tabId == null }, "Test on this page"), h("button", { class: "primary", on: { click: () => void save() } }, "Save")),
    );
  }
}

export function renderProfilesTab(root: HTMLElement): void {
  if (editing) return renderEditor(root);
  root.append(h("div", { class: "row between" }, h("span", { class: "muted small" }, `${state.profiles.length} profiles`), h("button", { class: "primary sm", on: { click: () => openEditor() } }, "New profile")));
  const sorted = [...state.profiles].sort((a, b) => Number(!!b.builtin) - Number(!!a.builtin) || a.name.localeCompare(b.name));
  for (const p of sorted) root.append(renderProfileCard(p));
}
