import type { Candidate, Match, WebhookResolverConfig } from "../../shared/types";

export async function postWebhook(config: WebhookResolverConfig, candidate: Candidate, match: Match, page: { url: string; title: string }): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(config.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(config.headers ?? {}) },
    body: JSON.stringify({ page, candidate: { id: candidate.id, text: candidate.text, source: candidate.source, context: candidate.context }, match }),
  });
  return { ok: res.ok, status: res.status };
}
