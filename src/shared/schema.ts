import { z } from "zod";
import { CANDIDATE_SOURCES, type CompiledProfile } from "./types";

const questionTypeSchema = z.enum(["noul", "choice", "score"]);

export const jevQuestionSchema = z
  .object({
    type: questionTypeSchema,
    instructions: z.string().min(1),
    criteria: z.record(z.string(), z.string()),
  })
  .superRefine((q, ctx) => {
    const keys = Object.keys(q.criteria);
    if (q.type === "noul") {
      if (!("true" in q.criteria) || !("false" in q.criteria) || keys.length !== 2) {
        ctx.addIssue({ code: "custom", message: `noul criteria must have exactly the keys "true" and "false"` });
      }
    } else if (q.type === "choice") {
      if (keys.length < 2 || keys.length > 255) {
        ctx.addIssue({ code: "custom", message: "choice criteria must have between 2 and 255 options" });
      }
    } else if (q.type === "score") {
      if (keys.length < 2 || keys.length > 10) {
        ctx.addIssue({ code: "custom", message: "score criteria must have between 2 and 10 levels" });
      }
    }
  });

export const jevQuestionTemplateSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "template id must be an identifier"),
    type: questionTypeSchema,
    instructions: z.string().min(1),
    criteria: z.record(z.string(), z.string()),
  })
  .superRefine((q, ctx) => {
    if (!q.instructions.includes("{cid}")) {
      ctx.addIssue({ code: "custom", message: `instructions must reference "candidate {cid}"` });
    }
    const parsed = jevQuestionSchema.safeParse({ type: q.type, instructions: q.instructions, criteria: q.criteria });
    if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", message: issue.message });
  });

export const resolverConfigSchema = z.object({
  type: z.enum(["geocode", "webhook", "none"]),
  when: z.object({
    field: z.string(),
    equals: z.string().optional(),
    in: z.array(z.string()).optional(),
  }),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const userProfileSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  extract: z.string().min(1),
  matchPatterns: z.array(z.string()).default([]),
  pageTypeHint: z.string().optional(),
  resolvers: z.array(resolverConfigSchema).default([]),
});

const probability = z.number().min(0).max(1);

export const compiledProfileSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().nonnegative(),
    name: z.string().min(1),
    enabled: z.boolean(),
    customized: z.boolean().optional(),
    builtin: z.boolean().optional(),
    source: userProfileSchema.optional(),
    scope: z.object({
      matchPatterns: z.array(z.string()),
      siteOverrides: z.record(z.string(), z.enum(["always", "never", "ask"])).default({}),
      pageGate: jevQuestionSchema.optional(),
      pageGateThreshold: probability.default(0.5),
    }),
    selection: z.object({
      sources: z.array(z.enum(CANDIDATE_SOURCES as [string, ...string[]])).min(1),
      textPatterns: z.array(z.string()).optional(),
      structuredTypes: z.array(z.string()).optional(),
      maxCandidates: z.number().int().min(1).max(1000).default(200),
      contextChars: z.number().int().min(0).max(1000).default(120),
    }),
    questions: z.array(jevQuestionTemplateSchema).min(1),
    decision: z.object({
      acceptField: z.string(),
      acceptThreshold: probability.default(0.85),
      reviewThreshold: probability.default(0.5),
    }),
    resolvers: z.array(resolverConfigSchema).default([]),
    compiler: z.object({
      model: z.string(),
      compiledAt: z.string(),
      sourceHash: z.string(),
    }),
  })
  .superRefine((p, ctx) => {
    const ids = new Set(p.questions.map((q) => q.id));
    if (ids.size !== p.questions.length) ctx.addIssue({ code: "custom", message: "question template ids must be unique" });
    if (!ids.has(p.decision.acceptField)) {
      ctx.addIssue({ code: "custom", message: `decision.acceptField "${p.decision.acceptField}" is not a question id` });
    }
    const acceptQ = p.questions.find((q) => q.id === p.decision.acceptField);
    if (acceptQ && acceptQ.type !== "noul") {
      ctx.addIssue({ code: "custom", message: "decision.acceptField must reference a noul question" });
    }
    if (p.decision.reviewThreshold > p.decision.acceptThreshold) {
      ctx.addIssue({ code: "custom", message: "reviewThreshold must be <= acceptThreshold" });
    }
    for (const r of p.resolvers) {
      if (!ids.has(r.when.field)) ctx.addIssue({ code: "custom", message: `resolver.when.field "${r.when.field}" is not a question id` });
      if (r.type === "webhook" && typeof r.config.url !== "string") {
        ctx.addIssue({ code: "custom", message: "webhook resolver requires config.url" });
      }
    }
    for (const pattern of p.selection.textPatterns ?? []) {
      try {
        new RegExp(pattern, "gi");
      } catch {
        ctx.addIssue({ code: "custom", message: `invalid regex in textPatterns: ${pattern}` });
      }
    }
    for (const pattern of p.scope.matchPatterns) {
      if (!/^(\*|[a-z]+):\/\//i.test(pattern) && pattern !== "<all_urls>") {
        ctx.addIssue({ code: "custom", message: `invalid match pattern: ${pattern}` });
      }
    }
  });

export interface ValidationResult {
  ok: boolean;
  profile?: CompiledProfile;
  errors: string[];
}

export function validateCompiledProfile(input: unknown): ValidationResult {
  const result = compiledProfileSchema.safeParse(input);
  if (result.success) return { ok: true, profile: result.data as CompiledProfile, errors: [] };
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}

/**
 * JSON schema text shown to the compiler LLM. Written by hand so it stays readable
 * in the prompt and documents the intent of each field.
 */
export const COMPILED_PROFILE_JSON_SCHEMA = `{
  "type": "object",
  "required": ["scope", "selection", "questions", "decision", "resolvers"],
  "properties": {
    "scope": {
      "type": "object",
      "required": ["matchPatterns", "pageGateThreshold"],
      "properties": {
        "matchPatterns": { "type": "array", "items": { "type": "string" }, "description": "Chrome match patterns. Copy the user's patterns verbatim." },
        "pageGate": { "$ref": "#/$defs/question", "description": "Optional page-level noul question, asked once per page against {title, first heading, first 500 chars}. Only when the user gave a page-type hint." },
        "pageGateThreshold": { "type": "number", "minimum": 0, "maximum": 1 }
      }
    },
    "selection": {
      "type": "object",
      "required": ["sources", "maxCandidates", "contextChars"],
      "properties": {
        "sources": { "type": "array", "items": { "enum": ["structured_data", "semantic_html", "map_embeds", "text_patterns", "headings", "link_text", "table_cells", "list_items"] }, "description": "Extractors to run, in priority order." },
        "textPatterns": { "type": "array", "items": { "type": "string" }, "description": "JavaScript regex sources (no slashes, no flags) applied to visible text when sources includes text_patterns." },
        "structuredTypes": { "type": "array", "items": { "type": "string" }, "description": "JSON-LD @type values to keep when sources includes structured_data. Empty means all." },
        "maxCandidates": { "type": "integer", "default": 200 },
        "contextChars": { "type": "integer", "default": 120 }
      }
    },
    "questions": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["id", "type", "instructions", "criteria"],
        "properties": {
          "id": { "type": "string", "pattern": "^[a-zA-Z][a-zA-Z0-9_]*$" },
          "type": { "enum": ["noul", "choice", "score"] },
          "instructions": { "type": "string", "description": "Must mention 'candidate {cid}'. Asks exactly one thing." },
          "criteria": { "type": "object", "additionalProperties": { "type": "string" }, "description": "noul: keys 'true' and 'false'. choice: one key per option. score: one key per level in order." }
        }
      }
    },
    "decision": {
      "type": "object",
      "required": ["acceptField", "acceptThreshold", "reviewThreshold"],
      "properties": {
        "acceptField": { "type": "string", "description": "id of the noul question that decides acceptance" },
        "acceptThreshold": { "type": "number", "default": 0.85 },
        "reviewThreshold": { "type": "number", "default": 0.5 }
      }
    },
    "resolvers": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["type", "when", "config"],
        "properties": {
          "type": { "enum": ["geocode", "webhook", "none"] },
          "when": { "type": "object", "required": ["field"], "properties": { "field": { "type": "string" }, "equals": { "type": "string" }, "in": { "type": "array", "items": { "type": "string" } } } },
          "config": { "type": "object" }
        }
      }
    }
  },
  "$defs": {
    "question": {
      "type": "object",
      "required": ["type", "instructions", "criteria"],
      "properties": {
        "type": { "enum": ["noul", "choice", "score"] },
        "instructions": { "type": "string" },
        "criteria": { "type": "object", "additionalProperties": { "type": "string" } }
      }
    }
  }
}`;
