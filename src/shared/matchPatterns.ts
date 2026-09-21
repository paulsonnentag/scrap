/**
 * Chrome extension match patterns: <scheme>://<host><path>
 * https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
 */

const SCHEMES = ["http", "https", "file", "ftp", "ws", "wss"];

export interface ParsedPattern {
  scheme: string; // "*" or a scheme
  host: string; // "*", "*.example.com", "example.com", or "" for file
  path: string; // starts with "/"
}

export function parseMatchPattern(pattern: string): ParsedPattern | null {
  const p = pattern.trim();
  if (p === "<all_urls>") return { scheme: "*", host: "*", path: "/*" };
  const m = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(p);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const host = m[2].toLowerCase();
  const path = m[3] ?? "/*";
  if (scheme !== "*" && !SCHEMES.includes(scheme)) return null;
  if (scheme === "file") {
    if (host !== "") return null;
    return { scheme, host, path };
  }
  if (host === "") return null;
  // Host: "*" or "*.something" or plain host; "*" allowed only as a leading component.
  if (host !== "*" && host.includes("*") && !host.startsWith("*.")) return null;
  if (host.slice(2).includes("*")) return null;
  return { scheme, host, path };
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function matchesPattern(pattern: string, url: string): boolean {
  const parsed = parseMatchPattern(pattern);
  if (!parsed) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  if (parsed.scheme === "*") {
    if (scheme !== "http" && scheme !== "https") return false;
  } else if (parsed.scheme !== scheme) {
    return false;
  }
  if (parsed.scheme !== "file") {
    const host = u.hostname.toLowerCase();
    if (parsed.host === "*") {
      // matches any host
    } else if (parsed.host.startsWith("*.")) {
      const suffix = parsed.host.slice(2);
      if (host !== suffix && !host.endsWith("." + suffix)) return false;
    } else if (parsed.host !== host) {
      return false;
    }
  }
  const pathAndQuery = u.pathname + u.search;
  return globToRegExp(parsed.path).test(pathAndQuery);
}

export function matchesAny(patterns: string[], url: string): boolean {
  return patterns.some((p) => matchesPattern(p, url));
}

/** Build a pattern that covers an origin: "https://example.com" → "https://example.com/*" */
export function patternForOrigin(origin: string): string {
  try {
    const u = new URL(origin);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return origin.endsWith("/*") ? origin : origin.replace(/\/?$/, "/*");
  }
}

/**
 * Does the pattern need the <all_urls> optional permission? True when the host is a bare "*"
 * for http/https, which no specific host_permission can cover.
 */
export function needsAllUrls(pattern: string): boolean {
  const parsed = parseMatchPattern(pattern);
  if (!parsed) return false;
  return parsed.host === "*";
}
