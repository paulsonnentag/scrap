import type { Candidate, CompiledProfile, GeocodeResolverConfig, Match, ResolverConfig, WebhookResolverConfig } from "../../shared/types";
import { lookupGeocode, verifyGeocodes, type PendingGeocode } from "./geocode";
import { postWebhook } from "./webhook";

export interface ResolverJob {
  profile: CompiledProfile;
  candidate: Candidate;
  match: Match;
  resolvers: ResolverConfig[];
}

/**
 * Runs resolvers for every accepted match of a page scan. Geocoding is done per candidate
 * (the provider is throttled), but all Jev verifications are batched into one request.
 * Results are written into each job's match.resolved.
 */
export async function runResolvers(jobs: ResolverJob[], page: { url: string; title: string; lang: string }): Promise<void> {
  const pending: PendingGeocode[] = [];
  const wantsVerify = new Set<string>();

  for (const job of jobs) {
    const out: { [resolverType: string]: unknown } = (job.match.resolved ??= {});
    for (const r of job.resolvers) {
      try {
        switch (r.type) {
          case "geocode": {
            const config = r.config as unknown as GeocodeResolverConfig;
            const result = await lookupGeocode(job.candidate, config, page.lang);
            out.geocode = result;
            if (result) {
              pending.push({ candidate: job.candidate, result });
              if (config.verify) wantsVerify.add(job.candidate.id);
            }
            break;
          }
          case "webhook":
            out.webhook = await postWebhook(r.config as unknown as WebhookResolverConfig, job.candidate, job.match, page);
            break;
          case "none":
            out.none = true;
            break;
        }
      } catch (err) {
        out[r.type] = { error: (err as Error).message };
        console.warn(`[page-extractor] resolver ${r.type} failed for profile ${job.profile.id}`, err);
      }
    }
  }

  const toVerify = pending.filter((p) => wantsVerify.has(p.candidate.id));
  if (toVerify.length) {
    try {
      const discard = await verifyGeocodes(toVerify, page.lang);
      for (const job of jobs) {
        if (discard.has(job.candidate.id) && job.match.resolved) job.match.resolved.geocode = null;
      }
    } catch (err) {
      console.warn("[page-extractor] geocode verification failed; keeping unverified results", err);
    }
  }
}
