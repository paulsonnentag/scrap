/**
 * Assembles the pasteable debug report: the last scan's trace, the page source as the
 * extractors saw it, the event log, and a ranked diagnosis.
 */
import { BUILD_ID, type DebugReport, type PageSourceTrace } from "../shared/debug";
import type { GetDebugMsg, PageSourceReply } from "../shared/messages";
import { getLog, getScanTrace, jevCallsSince, ready } from "./debugLog";
import { listProfiles } from "./repo";

/** Ask the content script for the page source; fall back to an injected snapshot. */
async function capturePageSource(tabId: number, maxChars: number, raw: boolean): Promise<{ source: PageSourceTrace; reply?: PageSourceReply }> {
  try {
    const reply = (await chrome.tabs.sendMessage(tabId, { type: "COLLECT_PAGE_SOURCE", maxChars, raw })) as PageSourceReply | { type: "ERROR"; error: string } | undefined;
    if (reply && reply.type === "PAGE_SOURCE") {
      return {
        reply,
        source: {
          available: true,
          via: "content-script",
          readyState: reply.readyState,
          frameCount: reply.frameCount,
          contentBuildId: reply.buildId,
          bytesOriginal: reply.bytesOriginal,
          bytesIncluded: reply.bytesIncluded,
          truncated: reply.truncated,
          filtered: reply.filtered,
          html: reply.html,
          lastContentScan: reply.lastScan,
        },
      };
    }
    if (reply && reply.type === "ERROR") throw new Error(reply.error);
    throw new Error("the content script did not reply");
  } catch (err) {
    const contentError = (err as Error).message;
    // The content script is missing on pages loaded before the extension was installed or
    // reloaded, and on restricted URLs. Try an injected one-shot snapshot instead.
    try {
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (limit: number) => {
          const html = document.documentElement.outerHTML;
          return { html: html.slice(0, limit), bytesOriginal: html.length, readyState: document.readyState, frameCount: window.frames.length };
        },
        args: [maxChars],
      });
      const r = injected?.result as { html: string; bytesOriginal: number; readyState: string; frameCount: number } | undefined;
      if (!r) throw new Error("no result from the injected snapshot");
      return {
        source: {
          available: true,
          via: "scripting-api",
          error: `content script unreachable (${contentError}); injected a snapshot instead. The page most likely needs a reload.`,
          readyState: r.readyState,
          frameCount: r.frameCount,
          bytesOriginal: r.bytesOriginal,
          bytesIncluded: Math.min(r.html.length, maxChars),
          truncated: r.bytesOriginal > maxChars,
          filtered: false,
          html: r.html,
        },
      };
    } catch (err2) {
      return { source: { available: false, via: "unavailable", error: `${contentError}; injection also failed: ${(err2 as Error).message}` } };
    }
  }
}

export async function buildDebugReport(msg: GetDebugMsg): Promise<DebugReport> {
  await ready();
  const manifest = chrome.runtime.getManifest();
  let tabUrl = "";
  try {
    tabUrl = (await chrome.tabs.get(msg.tabId)).url ?? "";
  } catch {
    // tab may be gone
  }

  const pageSource = msg.includeSource ? (await capturePageSource(msg.tabId, msg.maxSourceChars, msg.raw)).source : { available: false, via: "unavailable" as const, error: "not requested" };
  const scan = getScanTrace(msg.tabId);

  const report: DebugReport = {
    generatedAt: new Date().toISOString(),
    extensionVersion: manifest.version,
    buildId: BUILD_ID,
    browser: navigator.userAgent,
    tabUrl: tabUrl || scan?.url || "",
    scan,
    profiles: await listProfiles().catch(() => []),
    jevCalls: jevCallsSince(scan?.startedAt ?? "", undefined),
    pageSource,
    log: getLog(),
  };
  return report;
}
