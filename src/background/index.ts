import type { ActiveProfilesMsg, ContentToBackground, PanelToBackground } from "../shared/messages";
import { broadcast, sendToTab } from "../shared/messages";
import type { CompiledProfile, SiteOverrideMode } from "../shared/types";
import { compileProfile } from "./compiler";
import { buildDebugReport } from "./debugReport";
import { clearDebugState, logEvent } from "./debugLog";
import { verifyKey } from "./openrouter";
import { clearAllOrigins, clearOrigin, deleteProfile, docSizes, getProfile, listProfiles, readOriginDoc, saveProfile, setMatchStatus, updateProfile } from "./repo";
import { handleCandidates, originOf, resolveActiveProfiles, tabs } from "./scan";
import { clearAllStorage, getApiKey, getSettings, getSpend, patchSettings, setApiKey, setAskDecision } from "./storage";

const isChromeSidePanel = typeof chrome.sidePanel !== "undefined";

chrome.runtime.onInstalled.addListener(async (details) => {
  if (isChromeSidePanel) {
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    } catch (err) {
      console.warn("[page-extractor] setPanelBehavior failed", err);
    }
  }
  if (details.reason === "install") {
    // Opening the side panel programmatically needs a user gesture on Chrome, so on first
    // install we open the panel page in a tab, which walks the user through setup.
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel.html?firstrun=1") });
    } catch (err) {
      console.warn("[page-extractor] could not open first-run page", err);
    }
  }
});

// Firefox: sidebar_action has no setPanelBehavior; clicking the action toggles the sidebar.
chrome.action?.onClicked.addListener(async (tab) => {
  if (isChromeSidePanel && tab.windowId != null) {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch {
      // openPanelOnActionClick already handles this in most cases
    }
  } else if ((globalThis as any).browser?.sidebarAction) {
    (globalThis as any).browser.sidebarAction.toggle();
  }
});

// Best-effort detection of Cache-Control: no-store on top-level documents. Requires host permission.
try {
  chrome.webRequest?.onHeadersReceived.addListener(
    (details) => {
      if (details.type !== "main_frame" || details.tabId < 0) return undefined;
      const cc = details.responseHeaders?.find((h) => h.name.toLowerCase() === "cache-control")?.value ?? "";
      const noStore = /no-store/i.test(cc);
      const state = tabs.get(details.tabId);
      if (state) state.noStore = noStore;
      else tabs.set(details.tabId, { url: details.url, origin: originOf(details.url), profiles: [], noStore });
      return undefined;
    },
    { urls: ["<all_urls>"], types: ["main_frame"] },
    ["responseHeaders"],
  );
} catch (err) {
  console.debug("[page-extractor] webRequest unavailable", err);
}

chrome.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && info.url) {
    const state = tabs.get(tabId);
    if (state && state.url !== info.url) {
      state.url = info.url;
      state.origin = originOf(info.url);
      state.profiles = [];
      state.lastScan = undefined;
    }
  }
});

chrome.runtime.onMessage.addListener((msg: ContentToBackground | PanelToBackground, sender, sendResponse) => {
  handle(msg, sender)
    .then((result) => sendResponse(result))
    .catch((err: Error) => {
      logEvent("error", `message/${msg.type}`, err.message, err.stack);
      sendResponse({ type: "ERROR", error: err.message });
    });
  return true; // async response
});

async function handle(msg: ContentToBackground | PanelToBackground, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    // --- Content script ----------------------------------------------------
    case "GET_ACTIVE_PROFILES": {
      const tabId = sender.tab?.id;
      if (tabId == null) return { type: "ACTIVE_PROFILES", profiles: [] } satisfies ActiveProfilesMsg;
      const res = await resolveActiveProfiles(tabId, msg.url, msg.title, msg.summary, msg.noStore);
      if (res.skipped) await broadcast({ type: "PAGE", tabId, url: msg.url, matches: [], summary: tabs.get(tabId)?.lastScan });
      return { type: "ACTIVE_PROFILES", profiles: res.profiles, skipped: res.skipped } satisfies ActiveProfilesMsg;
    }
    case "CANDIDATES": {
      const tabId = sender.tab?.id;
      if (tabId == null) return { ok: false };
      const summary = await handleCandidates(tabId, msg);
      return { ok: true, summary };
    }

    // --- Side panel: page ----------------------------------------------------
    case "GET_PAGE": {
      const state = tabs.get(msg.tabId);
      const tab = await chrome.tabs.get(msg.tabId).catch(() => undefined);
      const url = tab?.url ?? state?.url ?? "";
      let matches = state?.lastScan?.url === url ? state.lastScan.matches : [];
      if (!matches.length && url) {
        const doc = await readOriginDoc(originOf(url)).catch(() => undefined);
        matches = doc?.pages?.[url]?.matches ?? [];
      }
      return { type: "PAGE", tabId: msg.tabId, url, matches, summary: state?.lastScan?.url === url ? state.lastScan : undefined };
    }
    case "RESCAN": {
      const state = tabs.get(msg.tabId);
      if (state) state.testProfiles = undefined;
      try {
        await sendToTab(msg.tabId, { type: "RESCAN_CONTENT" });
        return { ok: true };
      } catch (err) {
        // No content script in this tab: it predates the extension install or reload.
        logEvent("warn", "message/RESCAN", (err as Error).message, { tabId: msg.tabId });
        return { ok: false, error: "The content script is not running in this tab. Reload the page and try again." };
      }
    }
    case "REVIEW": {
      const match = await setMatchStatus(msg.origin, msg.url, msg.matchId, msg.decision);
      for (const state of tabs.values()) {
        if (state.lastScan?.url === msg.url) {
          const m = state.lastScan.matches.find((x) => x.id === msg.matchId);
          if (m) m.status = msg.decision;
        }
      }
      return { ok: !!match, match };
    }
    case "SITE_OVERRIDE": {
      const profile = await updateProfile(msg.profileId, (p) => {
        if (!p.scope.siteOverrides) p.scope.siteOverrides = {};
        if (msg.mode == null) delete p.scope.siteOverrides[msg.origin];
        else p.scope.siteOverrides[msg.origin] = msg.mode;
      });
      return { ok: !!profile, profile };
    }

    // --- Side panel: profiles -----------------------------------------------
    case "GET_PROFILES":
      return { profiles: await listProfiles() };
    case "COMPILE_PROFILE": {
      const existing = msg.profile.id ? await getProfile(msg.profile.id) : undefined;
      const result = await compileProfile(msg.profile, existing);
      return { type: "COMPILED", compiled: result.compiled, warnings: result.warnings };
    }
    case "SAVE_PROFILE": {
      const saved = await saveProfile(msg.profile);
      return { ok: true, profile: saved };
    }
    case "DELETE_PROFILE":
      await deleteProfile(msg.profileId);
      return { ok: true };
    case "TOGGLE_PROFILE": {
      const profile = await updateProfile(msg.profileId, (p) => {
        p.enabled = msg.enabled;
      });
      return { ok: !!profile, profile };
    }
    case "TEST_PROFILE": {
      const state = tabs.get(msg.tabId);
      const tab = await chrome.tabs.get(msg.tabId);
      const url = tab.url ?? state?.url ?? "";
      const st = state ?? { url, origin: originOf(url), profiles: [] };
      st.url = url;
      st.origin = originOf(url);
      st.testProfiles = [msg.compiled];
      tabs.set(msg.tabId, st);
      await sendToTab(msg.tabId, { type: "RESCAN_CONTENT", profiles: [msg.compiled] });
      return { ok: true };
    }

    // --- Side panel: settings -------------------------------------------------
    case "SET_KEY": {
      if (!msg.key) {
        await setApiKey("");
        return { type: "KEY_STATUS", status: { valid: false } };
      }
      const status = await verifyKey(msg.key);
      if (status.valid) await setApiKey(msg.key);
      return { type: "KEY_STATUS", status };
    }
    case "GET_KEY_STATUS": {
      const key = await getApiKey();
      if (!key) return { type: "KEY_STATUS", status: { valid: false } };
      return { type: "KEY_STATUS", status: await verifyKey(key) };
    }
    case "GET_SETTINGS":
      return { settings: await getSettings(), hasKey: !!(await getApiKey()) };
    case "SET_SETTINGS":
      return { settings: await patchSettings(msg.patch) };
    case "GET_SPEND":
      return { spend: await getSpend() };
    case "ASK_DECISION": {
      await setAskDecision(msg.profileId, msg.origin, msg.allow);
      if (msg.allow) await sendToTab(msg.tabId, { type: "RESCAN_CONTENT" }).catch(() => undefined);
      return { ok: true };
    }

    // --- Side panel: data -----------------------------------------------------
    case "GET_DEBUG":
      return { report: await buildDebugReport(msg) };
    case "CLEAR_DEBUG":
      await clearDebugState();
      return { ok: true };
    case "GET_DATA_INDEX":
      return { sizes: await docSizes() };
    case "GET_ORIGIN_DOC":
      return { doc: await readOriginDoc(msg.origin) };
    case "CLEAR_SITE":
      await clearOrigin(msg.origin);
      return { ok: true };
    case "CLEAR_ALL":
      await clearAllOrigins();
      await clearAllStorage();
      return { ok: true };
    default:
      return { type: "ERROR", error: `unknown message ${(msg as { type: string }).type}` };
  }
}

export type { CompiledProfile, SiteOverrideMode };
