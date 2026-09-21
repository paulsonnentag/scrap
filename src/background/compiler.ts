/**
 * Profile compiler: one LLM call that turns a UserProfile into a CompiledProfile.
 * Runs on save/edit only, never at page time.
 */
import { COMPILED_PROFILE_JSON_SCHEMA, validateCompiledProfile } from "../shared/schema";
import type { CompiledProfile, UserProfile } from "../shared/types";
import { newId, sha256Hex } from "../shared/hash";
import { chatCompletion } from "./openrouter";
import { getSettings } from "./storage";

export const COMPILER_SYSTEM_PROMPT = `You compile plain-language extraction profiles into question sets for Jev, TypeSafe AI's System One decision model.

Jev is a decision model, not a text generator. It does not extract entities or call tools. The extension proposes candidate DOM nodes (each with an ID like "c17", its text, tag, source, and nearby context), and Jev answers typed questions about each candidate. Jev evaluates every question in isolation and returns a calibrated probability per answer.

Your job: return a JSON object that fills the "scope", "selection", "questions", "decision", and "resolvers" fields of a CompiledProfile, following this JSON schema exactly:

${COMPILED_PROFILE_JSON_SCHEMA}

Rules:
1. Write one question per concept. Each question asks exactly ONE thing and references "candidate {cid}" literally, with the braces. Never combine conditions with "and"/"or".
2. Use type "noul" for accept/reject decisions and "choice" for categorisation. Use "score" only when the user asks for a ranking or rating.
3. Keep questions self-contained. A question cannot refer to another question's answer.
4. Encode exclusions the user mentioned inside the question and its criteria, not as a separate question. Example: "Ignore the HQ mailing address" becomes "Candidate {cid} is a customer-facing venue location, not a corporate or mailing address."
5. Write criteria carefully: for noul, keys "true" and "false" each describe what qualifies. For choice, one key per option using snake_case identifiers; include a catch-all option such as "none" or "other". Criteria matter as much as the instructions.
6. Exactly one noul question decides acceptance; set decision.acceptField to its id.
7. Pick selection.sources that match the target. Addresses need "semantic_html", "text_patterns", "map_embeds", and "structured_data". Product names need "headings", "list_items", and "table_cells". Contact details need "text_patterns" and "link_text". Dates and events need "text_patterns", "list_items", and "structured_data". Include "structured_data" whenever schema.org types exist for the target and list them in selection.structuredTypes.
8. When you include "text_patterns", provide selection.textPatterns as JavaScript regex source strings (no surrounding slashes, no flags; use \\\\ to escape). Keep them broad enough to catch variants; Jev filters false positives.
9. Copy the user's match patterns verbatim into scope.matchPatterns. Do not invent patterns.
10. If the user provided a page-type hint, generate scope.pageGate: a noul question about the page as a whole (asked once per page against the title, first heading, and first 500 characters). Otherwise omit pageGate. Set pageGateThreshold to 0.5.
11. Use conservative defaults: acceptThreshold 0.85, reviewThreshold 0.5, maxCandidates 200, contextChars 120.
12. Copy the user's resolvers into "resolvers", and set each resolver's "when" to reference one of your question ids (for geocode, prefer a choice question whose options separate street addresses and named places from regions and non-places).
13. Return ONLY the JSON object. No prose, no code fences.`;

function userPrompt(profile: UserProfile): string {
  return JSON.stringify(
    {
      name: profile.name,
      what_to_extract: profile.extract,
      where_it_applies: { match_patterns: profile.matchPatterns, page_type_hint: profile.pageTypeHint ?? null },
      what_to_do_with_matches: profile.resolvers,
    },
    null,
    2,
  );
}

export interface CompileResult {
  compiled: CompiledProfile;
  warnings: string[];
}

function stripFences(text: string): string {
  const t = text.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  return m ? m[1] : t;
}

/** Merge the LLM output with the identity fields we control. */
function assemble(llmOutput: unknown, profile: UserProfile, model: string, sourceHash: string, existing?: CompiledProfile): unknown {
  const o = (llmOutput && typeof llmOutput === "object" ? llmOutput : {}) as Record<string, unknown>;
  const scope = (o.scope && typeof o.scope === "object" ? o.scope : {}) as Record<string, unknown>;
  return {
    id: existing?.id ?? profile.id ?? newId("p"),
    version: (existing?.version ?? 0) + 1,
    name: profile.name,
    enabled: existing?.enabled ?? true,
    customized: false,
    source: profile,
    scope: {
      ...scope,
      matchPatterns: profile.matchPatterns, // never trust the LLM with scope
      siteOverrides: existing?.scope.siteOverrides ?? {},
      pageGateThreshold: typeof scope.pageGateThreshold === "number" ? scope.pageGateThreshold : 0.5,
    },
    selection: o.selection,
    questions: o.questions,
    decision: o.decision,
    resolvers: Array.isArray(o.resolvers) && (o.resolvers as unknown[]).length ? o.resolvers : profile.resolvers,
    compiler: { model, compiledAt: new Date().toISOString(), sourceHash },
  };
}

export async function compileProfile(profile: UserProfile, existing?: CompiledProfile): Promise<CompileResult> {
  const settings = await getSettings();
  const model = settings.compilerModel;
  const sourceHash = await sha256Hex(JSON.stringify(profile));
  const warnings: string[] = [];

  const messages = [
    { role: "system" as const, content: COMPILER_SYSTEM_PROMPT },
    { role: "user" as const, content: userPrompt(profile) },
  ];

  let lastErrors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await chatCompletion(messages, model, "compile");
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFences(raw));
    } catch (err) {
      lastErrors = [`Compiler returned invalid JSON: ${(err as Error).message}`];
      messages.push({ role: "assistant" as const, content: raw } as never, {
        role: "user" as const,
        content: `That was not valid JSON (${lastErrors[0]}). Return only the JSON object.`,
      } as never);
      continue;
    }
    const result = validateCompiledProfile(assemble(parsed, profile, model, sourceHash, existing));
    if (result.ok && result.profile) {
      if (profile.pageTypeHint && !result.profile.scope.pageGate) warnings.push("The compiler did not generate a page gate despite the page-type hint.");
      if (!profile.matchPatterns.length) warnings.push("This profile has no match patterns, so it runs nowhere until you enable it for a site.");
      for (const q of result.profile.questions) {
        if (/\b(and|or)\b/i.test(q.instructions.replace(/candidate \{cid\}/g, ""))) {
          warnings.push(`Question "${q.id}" may be a compound condition; consider splitting it.`);
        }
      }
      if (result.profile.selection.sources.includes("text_patterns") && !result.profile.selection.textPatterns?.length) {
        warnings.push("text_patterns is selected but no textPatterns were generated; the default address patterns will be used.");
      }
      return { compiled: result.profile, warnings };
    }
    lastErrors = result.errors;
    messages.push({ role: "assistant" as const, content: raw } as never, {
      role: "user" as const,
      content: `The JSON failed schema validation with these errors:\n- ${lastErrors.join("\n- ")}\n\nFix them and return only the corrected JSON object.`,
    } as never);
  }
  throw new Error(`Profile compilation failed validation:\n- ${lastErrors.join("\n- ")}`);
}
