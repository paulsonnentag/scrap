/**
 * Pages we never scan: banking, healthcare, email, authentication.
 * These are heuristic URL patterns; per-site "never" overrides give users precise control.
 */
const SENSITIVE_HOST_PARTS = [
  "bank",
  "banking",
  "paypal.",
  "venmo.",
  "wise.com",
  "revolut.",
  "chase.com",
  "wellsfargo",
  "citi.com",
  "hsbc.",
  "barclays",
  "santander",
  "schwab",
  "fidelity",
  "vanguard",
  "coinbase",
  "kraken.com",
  "binance",
  "mail.google.",
  "outlook.live.",
  "outlook.office.",
  "mail.yahoo.",
  "mail.proton.",
  "protonmail",
  "fastmail",
  "myhealth",
  "mychart",
  "patient",
  "healthcare",
  "medic",
  "clinic",
  "hospital",
  "pharmacy",
  "insurance",
];

const SENSITIVE_PATH_SEGMENTS = [
  "login",
  "signin",
  "sign-in",
  "sign_in",
  "auth",
  "oauth",
  "sso",
  "password",
  "reset-password",
  "2fa",
  "mfa",
  "checkout",
  "payment",
  "payments",
  "billing",
  "wallet",
  "banking",
  "inbox",
  "mail",
  "webmail",
  "medical",
  "patient",
  "prescription",
  "prescriptions",
];
const SENSITIVE_PATH_RE = new RegExp(`(^|/)(${SENSITIVE_PATH_SEGMENTS.join("|")})(/|$|[?#.])`, "i");

const SENSITIVE_SCHEMES = ["chrome:", "chrome-extension:", "moz-extension:", "about:", "edge:", "devtools:", "view-source:"];

export interface SensitiveVerdict {
  reason: string;
  /** Host heuristics are noisy ("bank" in "bankrate") and can be overridden per site; path and scheme rules cannot. */
  kind: "scheme" | "host" | "path";
}

export function classifySensitiveUrl(url: string): SensitiveVerdict | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { reason: "unparseable URL", kind: "scheme" };
  }
  if (SENSITIVE_SCHEMES.includes(u.protocol)) return { reason: "browser-internal page", kind: "scheme" };
  const m = SENSITIVE_PATH_RE.exec(u.pathname.toLowerCase());
  if (m) return { reason: `sensitive path (/${m[2]})`, kind: "path" };
  const host = u.hostname.toLowerCase();
  for (const part of SENSITIVE_HOST_PARTS) {
    if (host.includes(part)) return { reason: `sensitive host (${part})`, kind: "host" };
  }
  return null;
}

export function isSensitiveUrl(url: string): string | null {
  return classifySensitiveUrl(url)?.reason ?? null;
}
