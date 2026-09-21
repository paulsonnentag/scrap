import { normalizeText } from "../../shared/hash";
import type { JevQuestion } from "../../shared/types";
import type { Candidate, GeocodeResolverConfig, GeocodeResult } from "../../shared/types";
import { JEV_MODEL } from "../../shared/jev";
import { normalizeAnswer, truthProbability } from "../../shared/jev";
import { systemOne } from "../openrouter";
import { getCachedGeocode, setCachedGeocode } from "../storage";

export interface Geocoder {
  readonly name: string;
  resolve(query: string, hints?: { lang?: string; countryBias?: string }): Promise<{ lat: number; lng: number; displayName: string; confidence: number } | null>;
}

/** Nominatim: free, one request per second, requires an identifying User-Agent/Referer. */
export class NominatimGeocoder implements Geocoder {
  readonly name = "nominatim";
  private lastRequest = 0;
  private queue: Promise<void> = Promise.resolve();

  private throttle(): Promise<void> {
    const run = async () => {
      const wait = Math.max(0, 1100 - (Date.now() - this.lastRequest));
      if (wait) await new Promise((r) => setTimeout(r, wait));
      this.lastRequest = Date.now();
    };
    const next = this.queue.then(run, run);
    this.queue = next;
    return next;
  }

  async resolve(query: string, hints?: { lang?: string; countryBias?: string }) {
    await this.throttle();
    const params = new URLSearchParams({ q: query, format: "jsonv2", limit: "1", addressdetails: "0" });
    if (hints?.lang) params.set("accept-language", hints.lang);
    if (hints?.countryBias) params.set("countrycodes", hints.countryBias.toLowerCase());
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { Accept: "application/json", Referer: "https://github.com/paulsonnentag/scrap" },
    });
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    const json = (await res.json()) as Array<{ lat: string; lon: string; display_name: string; importance?: number }>;
    const hit = json[0];
    if (!hit) return null;
    return {
      lat: Number(hit.lat),
      lng: Number(hit.lon),
      displayName: hit.display_name,
      confidence: Math.max(0, Math.min(1, hit.importance ?? 0.5)),
    };
  }
}

const geocoders: Record<string, Geocoder> = { nominatim: new NominatimGeocoder() };

export function getGeocoder(provider = "nominatim"): Geocoder {
  return geocoders[provider] ?? geocoders.nominatim;
}

const verifyQuestion = (cid: string, displayName: string): JevQuestion => ({
  type: "noul",
  instructions: `The geocoded result "${displayName}" matches the place described by candidate ${cid}.`,
  criteria: {
    true: "The geocoder result refers to the same street address, venue, or landmark as the candidate.",
    false: "The result is a different place, a region containing the place, or unrelated.",
  },
});

export const VERIFY_THRESHOLD = 0.7;

export interface PendingGeocode {
  candidate: Candidate;
  result: GeocodeResult;
}

/** Phase 1: look up coordinates (page hints first, then cache, then the provider). No Jev call. */
export async function lookupGeocode(candidate: Candidate, config: GeocodeResolverConfig, lang: string): Promise<GeocodeResult | null> {
  if (candidate.hints.lat != null && candidate.hints.lng != null) {
    return { lat: candidate.hints.lat, lng: candidate.hints.lng, provider: "page_hint", displayName: candidate.text, confidence: 1, verified: true };
  }
  const geocoder = getGeocoder(config.provider);
  const key = `${geocoder.name}|${normalizeText(candidate.text)}`;
  let base = await getCachedGeocode(key);
  if (base === undefined) {
    const hit = await geocoder.resolve(candidate.text, { lang, countryBias: config.countryBias });
    base = hit ? { ...hit, provider: geocoder.name } : null;
    await setCachedGeocode(key, base);
  }
  return base ? { ...base } : null;
}

/**
 * Phase 2: verify a batch of geocoder results with a single Jev request.
 * Returns the ids of candidates whose result should be discarded.
 */
export async function verifyGeocodes(pending: PendingGeocode[], lang: string): Promise<Set<string>> {
  const discard = new Set<string>();
  const toVerify = pending.filter((p) => p.result.provider !== "page_hint");
  if (!toVerify.length) return discard;
  const questions: { [qid: string]: JevQuestion } = {};
  for (const p of toVerify) questions[`${p.candidate.id}_geoverify`] = verifyQuestion(p.candidate.id, p.result.displayName);
  const res = await systemOne(
    {
      model: JEV_MODEL,
      state: {
        page: { url: "", title: "Geocoder results to verify", lang },
        candidates: toVerify.map(({ candidate: c }) => ({ id: c.id, text: c.text, tag: c.tag, source: c.source, context: c.context, hints: c.hints })),
      },
      questions,
    },
    "geocode_verify",
  );
  for (const p of toVerify) {
    const qid = `${p.candidate.id}_geoverify`;
    const prob = truthProbability(normalizeAnswer(res.answers?.[qid], questions[qid]) ?? undefined);
    if (prob < VERIFY_THRESHOLD) discard.add(p.candidate.id);
    else p.result.verified = true;
  }
  return discard;
}
