import { sendToBackground } from "../../shared/messages";
import type { CompiledProfile, KeyStatus, Settings } from "../../shared/types";
import { refreshProfiles, refreshSettings, state } from "../state";
import { h, money, toast } from "../ui";
import { requestHostPermission } from "../permissions";
import { renderDebugSection } from "./debug";

const MODEL_SUGGESTIONS = ["openai/gpt-4.1-mini", "anthropic/claude-sonnet-5", "google/gemini-2.5-flash", "openai/gpt-4.1", "anthropic/claude-opus-5"];

async function verify(input: HTMLInputElement, status: HTMLElement): Promise<void> {
  status.replaceChildren(h("span", { class: "spinner" }));
  const res = await sendToBackground<{ status: KeyStatus }>({ type: "SET_KEY", key: input.value.trim() }).catch(() => undefined);
  const s = res?.status;
  state.keyStatus = s;
  state.hasKey = !!s?.valid;
  if (s?.valid) {
    status.replaceChildren(h("span", { class: "badge ok" }, "valid"), " ", h("span", { class: "small muted" }, `${s.label ?? "key"}${s.credit != null ? ` · ${money(s.credit)} remaining` : ""}`));
  } else status.replaceChildren(h("span", { class: "badge bad" }, s?.error ? `invalid: ${s.error}` : "not set"));
  await refreshSettings();
}

async function patch(p: Partial<Settings>): Promise<void> {
  await sendToBackground({ type: "SET_SETTINGS", patch: p });
  await refreshSettings();
}

function renderFirstRun(root: HTMLElement): void {
  const builtins = state.profiles.filter((p) => p.builtin);
  let chosen: CompiledProfile | undefined = builtins[0];
  let scopeChoice: "all" | "added" = "added";
  const keyInput = h("input", { type: "password", placeholder: "sk-or-…", autocomplete: "off" });
  const keyStatus = h("span", {}, state.hasKey ? h("span", { class: "badge ok" }, "saved") : null);
  root.append(
    h("div", { class: "card steps" }, h("p", {}, h("b", {}, "Welcome. Three steps and you're set.")), h("p", { class: "small muted" }, "Everything runs in your browser. Page content is sent to OpenRouter (and on to TypeSafe's Jev) only on pages where a profile is active. Nothing is scanned until step 3 is complete.")),
    h(
      "section",
      { class: "step" },
      h("h2", {}, "Paste your OpenRouter key"),
      h("p", { class: "small muted" }, "Create a dedicated key with a spend limit at openrouter.ai/keys. It's stored in extension storage and only sent to OpenRouter."),
      h("div", { class: "row" }, keyInput, h("button", { on: { click: () => void verify(keyInput, keyStatus) } }, "Verify")),
      keyStatus,
    ),
    h(
      "section",
      { class: "step" },
      h("h2", {}, "Pick a built-in profile"),
      ...builtins.map((p) => h("label", { class: "inline", style: "display:flex;margin:4px 0" }, h("input", { type: "radio", name: "fr-profile", checked: p === chosen, on: { change: () => (chosen = p) } }), h("span", {}, h("b", {}, p.name), " ", h("span", { class: "muted small" }, p.source?.extract ?? "")))),
    ),
    h(
      "section",
      { class: "step" },
      h("h2", {}, "Where should it run?"),
      h("label", { class: "inline", style: "display:flex;margin:4px 0" }, h("input", { type: "radio", name: "fr-scope", checked: true, on: { change: () => (scopeChoice = "added") } }), h("span", {}, h("b", {}, "Only sites I add"), h("div", { class: "muted small" }, "Use the per-site switch in Profiles. Most private."))),
      h("label", { class: "inline", style: "display:flex;margin:4px 0" }, h("input", { type: "radio", name: "fr-scope", on: { change: () => (scopeChoice = "all") } }), h("span", {}, h("b", {}, "All sites"), h("div", { class: "muted small" }, "Requests permission for all URLs. Sensitive pages (banking, mail, auth) are always skipped."))),
      h(
        "button",
        {
          class: "primary",
          style: "margin-top:8px",
          on: {
            click: async () => {
              if (!state.hasKey) return toast("Verify your key first.");
              if (!chosen) return toast("Pick a profile.");
              if (scopeChoice === "all") {
                if (!(await requestHostPermission(["<all_urls>"]))) return toast("Permission for all URLs was not granted.");
                const p = { ...chosen, scope: { ...chosen.scope, matchPatterns: ["<all_urls>"] }, enabled: true };
                await sendToBackground({ type: "SAVE_PROFILE", profile: p });
              } else {
                await sendToBackground({ type: "TOGGLE_PROFILE", profileId: chosen.id, enabled: true });
              }
              await patch({ onboarded: true });
              await refreshProfiles();
              toast("You're set. Open a page and check “This page”.");
            },
          },
        },
        "Finish setup",
      ),
    ),
  );
}

export function renderSettingsTab(root: HTMLElement): void {
  const s = state.settings;
  if (!s) return void root.append(h("span", { class: "spinner" }));
  if (!s.onboarded) return renderFirstRun(root);

  const keyInput = h("input", { type: "password", placeholder: state.hasKey ? "•••••••• (saved)" : "sk-or-…", autocomplete: "off" });
  const keyStatus = h("span", {});
  if (state.hasKey) {
    keyStatus.append(h("span", { class: "badge ok" }, "saved"));
    void sendToBackground<{ status: KeyStatus }>({ type: "GET_KEY_STATUS" }).then((r) => {
      const ks = r?.status;
      if (ks?.valid) keyStatus.replaceChildren(h("span", { class: "badge ok" }, "valid"), " ", h("span", { class: "small muted" }, `${ks.label ?? "key"}${ks.credit != null ? ` · ${money(ks.credit)} remaining` : ""}`));
      else if (ks) keyStatus.replaceChildren(h("span", { class: "badge bad" }, `invalid${ks.error ? `: ${ks.error}` : ""}`));
    });
  }

  const modelInput = h("input", { type: "text", value: s.compilerModel, on: { change: (e) => void patch({ compilerModel: (e.target as HTMLInputElement).value.trim() }) } });
  modelInput.setAttribute("list", "model-suggestions");
  const spend = state.spend;

  root.append(
    h("h2", {}, "OpenRouter"),
    h("div", { class: "row" }, keyInput, h("button", { on: { click: () => void verify(keyInput, keyStatus) } }, "Verify")),
    keyStatus,
    h("p", { class: "small muted" }, "Tip: create a dedicated key with a spend limit for this extension. ", h("a", { href: "https://openrouter.ai/settings/privacy", target: "_blank", rel: "noreferrer" }, "Provider data policies"), " are configured in your OpenRouter account."),
    h("label", { class: "field" }, h("span", {}, "Compiler model"), modelInput, h("datalist", { id: "model-suggestions" }, ...MODEL_SUGGESTIONS.map((m) => h("option", { value: m }))), h("div", { class: "small muted" }, "Any OpenRouter chat model. Used only when a profile is compiled.")),

    h("h2", {}, "Spend"),
    h("div", { class: "card" }, h("div", { class: "meter" }, money(spend?.totalCost ?? 0)), h("div", { class: "small muted" }, `${(spend?.totalTokens ?? 0).toLocaleString()} tokens · ${spend?.requests ?? 0} requests`), spend && Object.keys(spend.byPurpose).length ? h("table", { style: "margin-top:6px" }, ...Object.entries(spend.byPurpose).map(([k, v]) => h("tr", {}, h("td", {}, k), h("td", {}, money(v.cost)), h("td", { class: "muted" }, `${v.requests} req`)))) : null),

    h("h2", {}, "Geocoder"),
    h("label", { class: "field" }, h("span", {}, "Provider"), h("select", { on: { change: (e) => void patch({ geocoderProvider: (e.target as HTMLSelectElement).value as "nominatim" }) } }, h("option", { value: "nominatim", selected: true }, "Nominatim (OpenStreetMap, free, 1 req/s)"))),
    h("label", { class: "field" }, h("span", {}, "Provider key (unused for Nominatim)"), h("input", { type: "password", value: s.geocoderKey ?? "", on: { change: (e) => void patch({ geocoderKey: (e.target as HTMLInputElement).value || undefined }) } })),

    h(
      "details",
      {},
      h("summary", {}, "Advanced: direct TypeSafe access"),
      h("p", { class: "small muted" }, "If you have a TypeSafe account, Jev requests can bypass OpenRouter. The request body is identical; only the base URL, key, and model prefix differ."),
      h("label", { class: "field" }, h("span", {}, "TYPESAFE_BASE_URL"), h("input", { type: "url", value: s.typesafeBaseUrl ?? "", placeholder: "https://api.typesafe.ai", on: { change: (e) => void patch({ typesafeBaseUrl: (e.target as HTMLInputElement).value || undefined }) } })),
      h("label", { class: "field" }, h("span", {}, "TypeSafe key"), h("input", { type: "password", value: s.typesafeKey ?? "", on: { change: (e) => void patch({ typesafeKey: (e.target as HTMLInputElement).value || undefined }) } })),
      h(
        "button",
        {
          class: "sm",
          on: {
            click: async () => {
              const url = s.typesafeBaseUrl;
              if (!url) return toast("Set the base URL first.");
              toast((await requestHostPermission([new URL(url).origin + "/*"])) ? "Host permission granted" : "Permission denied");
            },
          },
        },
        "Grant host permission",
      ),
    ),
    h("p", { class: "small muted", style: "margin-top:14px" }, "Jev model: typesafe/jev-1.13 (pinned). Sensitive pages (banking, healthcare, mail, auth) and pages served with Cache-Control: no-store are never scanned."),
    h("button", { class: "sm", style: "margin-top:6px", on: { click: () => void patch({ onboarded: false }) } }, "Re-run first-time setup"),
  );
  renderDebugSection(root);
}
