import type { JevRequest, JevResponse } from "../shared/jev";
import type { KeyStatus } from "../shared/types";
import { getApiKey, getSettings, recordSpend } from "./storage";

export const OPENROUTER_BASE = "https://openrouter.ai/api";
const APP_HEADERS = {
  "HTTP-Referer": "https://github.com/paulsonnentag/scrap",
  "X-Title": "Page Extractor",
};

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: string,
  ) {
    super(message);
  }
}

interface Endpoint {
  baseUrl: string;
  key: string;
  /** Prefix to strip from model IDs when talking to TypeSafe directly. */
  stripModelPrefix?: string;
}

async function openRouterEndpoint(): Promise<Endpoint> {
  const key = await getApiKey();
  if (!key) throw new ApiError("No OpenRouter API key configured", 401);
  return { baseUrl: OPENROUTER_BASE, key };
}

/** Jev goes to TypeSafe directly when the advanced fallback is configured, else to OpenRouter. */
async function systemOneEndpoint(): Promise<Endpoint> {
  const settings = await getSettings();
  if (settings.typesafeBaseUrl && settings.typesafeKey) {
    return { baseUrl: settings.typesafeBaseUrl.replace(/\/$/, ""), key: settings.typesafeKey, stripModelPrefix: "typesafe/" };
  }
  return openRouterEndpoint();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** fetch with retry on 429/5xx, honoring retry-after, exponential backoff. */
async function fetchWithRetry(url: string, init: RequestInit, maxAttempts = 5): Promise<Response> {
  let attempt = 0;
  let delay = 1000;
  for (;;) {
    attempt++;
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      await sleep(delay);
      delay *= 2;
      continue;
    }
    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      if (attempt >= maxAttempts) return res;
      const ra = res.headers.get("retry-after");
      let wait = delay;
      if (ra) {
        const secs = Number(ra);
        if (Number.isFinite(secs)) wait = secs * 1000;
        else {
          const date = Date.parse(ra);
          if (!Number.isNaN(date)) wait = Math.max(0, date - Date.now());
        }
      }
      await sleep(Math.min(wait, 60_000));
      delay *= 2;
      continue;
    }
    return res;
  }
}

export async function verifyKey(key: string): Promise<KeyStatus> {
  try {
    const res = await fetch(`${OPENROUTER_BASE}/v1/auth/key`, {
      headers: { Authorization: `Bearer ${key}`, ...APP_HEADERS },
    });
    if (!res.ok) return { valid: false, error: `HTTP ${res.status}` };
    const json = (await res.json()) as { data?: { label?: string; limit?: number | null; usage?: number; limit_remaining?: number | null } };
    const d = json.data ?? {};
    const credit = d.limit_remaining ?? (d.limit != null && d.usage != null ? d.limit - d.usage : null);
    return { valid: true, label: d.label, credit };
  } catch (err) {
    return { valid: false, error: (err as Error).message };
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function chatCompletion(messages: ChatMessage[], model: string, purpose = "compile"): Promise<string> {
  const ep = await openRouterEndpoint();
  const res = await fetchWithRetry(`${ep.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ep.key}`, "Content-Type": "application/json", ...APP_HEADERS },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: "json_object" },
      temperature: 0.2,
      usage: { include: true },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError(`Chat completion failed: HTTP ${res.status}`, res.status, text);
  const json = JSON.parse(text) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { total_tokens?: number; cost?: number };
  };
  await recordSpend(purpose, json.usage?.cost, json.usage?.total_tokens);
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new ApiError("Chat completion returned no content", 502, text);
  return content;
}

/**
 * POST /api/v1/systemone. Body: { model, state, questions }.
 * Returns TypeSafe's { model, answers, usage } plus OpenRouter's id/provider/usage.cost.
 */
export async function systemOne(request: JevRequest, purpose = "judge"): Promise<JevResponse> {
  const ep = await systemOneEndpoint();
  const model = ep.stripModelPrefix && request.model.startsWith(ep.stripModelPrefix) ? request.model.slice(ep.stripModelPrefix.length) : request.model;
  const res = await fetchWithRetry(`${ep.baseUrl}/v1/systemone`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ep.key}`, "Content-Type": "application/json", ...APP_HEADERS },
    body: JSON.stringify({ ...request, model }),
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError(`System One request failed: HTTP ${res.status}`, res.status, text);
  const json = JSON.parse(text) as JevResponse;
  const tokens = json.usage?.total_tokens ?? json.usage?.input_tokens;
  await recordSpend(purpose, json.usage?.cost, tokens);
  console.debug("[page-extractor] jev", { id: json.id, model: json.model, provider: json.provider, cost: json.usage?.cost, tokens });
  return json;
}
