import { needsAllUrls } from "../shared/matchPatterns";
import { toast } from "./ui";

/**
 * chrome.permissions.request must run in the context that received the user gesture,
 * so the side panel calls it directly instead of routing through the service worker.
 */
export async function requestHostPermission(patterns: string[]): Promise<boolean> {
  const origins = Array.from(new Set(patterns.map((p) => (needsAllUrls(p) || p === "<all_urls>" ? "<all_urls>" : p))));
  if (!origins.length) return true;
  try {
    if (await chrome.permissions.contains({ origins })) return true;
    const granted = await chrome.permissions.request({ origins });
    if (!granted) toast("Host permission was not granted; the profile may not run on those sites.");
    return granted;
  } catch (err) {
    toast(`Permission request failed: ${(err as Error).message}`);
    return false;
  }
}
