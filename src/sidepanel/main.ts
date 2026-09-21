import type { BackgroundToPanel } from "../shared/messages";
import { notify, refreshActiveTab, refreshPage, refreshProfiles, refreshSettings, state, subscribe } from "./state";
import { renderDataTab } from "./tabs/data";
import { renderPageTab } from "./tabs/page";
import { renderProfilesTab } from "./tabs/profiles";
import { renderSettingsTab } from "./tabs/settings";
import { clear } from "./ui";

type TabName = "page" | "profiles" | "data" | "settings";
const RENDERERS: Record<TabName, (root: HTMLElement) => void> = {
  page: renderPageTab,
  profiles: renderProfilesTab,
  data: renderDataTab,
  settings: renderSettingsTab,
};

let current: TabName = "page";
const view = document.getElementById("view")!;

function render(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>(".tab")) b.classList.toggle("active", b.dataset.tab === current);
  clear(view);
  RENDERERS[current](view);
}

for (const b of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  b.addEventListener("click", () => {
    current = b.dataset.tab as TabName;
    render();
  });
}

subscribe(render);

chrome.runtime.onMessage.addListener((msg: BackgroundToPanel) => {
  switch (msg.type) {
    case "PAGE":
      if (msg.tabId === state.tabId) {
        state.url = msg.url;
        state.origin = new URL(msg.url).origin;
        state.matches = msg.matches;
        state.summary = msg.summary;
        notify();
      }
      break;
    case "ASK_PROFILE":
      if (!state.pendingAsks.some((a) => a.profileId === msg.profileId && a.origin === msg.origin)) {
        state.pendingAsks.push({ profileId: msg.profileId, profileName: msg.profileName, origin: msg.origin, tabId: msg.tabId });
        notify();
      }
      break;
    default:
      break;
  }
  return false;
});

chrome.tabs.onActivated.addListener(() => void refreshActiveTab());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === state.tabId && (info.url || info.status === "complete")) void refreshPage();
});
chrome.windows?.onFocusChanged?.addListener(() => void refreshActiveTab());

async function init(): Promise<void> {
  const params = new URLSearchParams(location.search);
  await Promise.all([refreshSettings(), refreshProfiles()]);
  if (params.get("firstrun") === "1" || !state.settings?.onboarded || !state.hasKey) current = "settings";
  await refreshActiveTab();
  render();
}

void init();
