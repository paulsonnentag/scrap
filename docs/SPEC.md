# Page Extractor: browser extension specification

This document describes a browser extension that extracts user-defined data from web pages, optionally resolves it with external services such as a geocoder, and stores the results in an Automerge document. The extension uses Jev, TypeSafe AI's System One model, to decide which page elements match what the user asked for.

Users configure **what** to extract and **where** to extract it through extraction profiles. Each profile is written in plain language and compiled into a Jev question set by a general-purpose LLM. Locations and businesses are the built-in example profile, not a hardcoded feature.

The extension has no backend. Everything runs inside the browser: configuration lives in a side panel, the API key is stored in extension storage, and all API calls go directly from the extension to OpenRouter.

**Status:** Draft
**Last updated:** September 21, 2026
**Target:** Chrome and Firefox, Manifest V3

## Overview

Jev is a decision model, not a text generator. It doesn't extract entities or call tools. Instead, your code proposes candidate DOM nodes and Jev answers typed questions about them, such as "Does this node describe a physical place that should be resolved to coordinates?"

Because Jev only answers questions, the questions themselves define what the extension extracts. Writing good Jev questions by hand is tedious and error-prone for end users, so the extension delegates that step to a conventional LLM. The LLM runs once per profile at configuration time, not on every page.

The extension works in four stages:

1. **Configure.** The user writes a profile: what to extract, on which pages, and what to do with matches. An LLM compiles the profile into a candidate-selection config and a Jev question template.
2. **Propose.** On a matching page, a content script scans the DOM and collects candidate nodes according to the profile's config.
3. **Judge.** The background service worker sends the candidates to Jev in a single request, with the profile's questions applied to each candidate. Jev returns a calibrated answer for each.
4. **Resolve and store.** Candidates above a confidence threshold run through the profile's resolvers, such as a geocoder. Results are written to an Automerge document persisted in IndexedDB.

### Goals

- Let users define arbitrary extraction targets without writing code or Jev questions.
- Let users scope each profile to specific sites, URL patterns, or page types.
- Identify every match on a page, not only the first one.
- Keep Jev requests under the context limit for typical pages without truncating meaningful content.
- Persist results locally in a mergeable, offline-first format.
- Keep per-page cost dominated by Jev, with the LLM used only at configuration time.
- Ship with no server component. The user's OpenRouter key and all data stay on their device.

### Non-goals

- Running an LLM on every page. Page-time inference is Jev only.
- Any hosted service, account system, or proxy. The extension talks to OpenRouter and geocoders directly.
- Generating text descriptions or summaries of extracted data.
- Extracting from pages the user hasn't visited.
- Syncing Automerge documents between devices. The data model supports it, but sync transport is out of scope for v1.

## Architecture

```
 Configuration time (once per profile)
┌──────────────────────┐        ┌──────────────────────────┐
│  Side panel          │  msg   │  Service worker          │
│  User enters API key │──────► │  (extension-internal,    │
│  and writes profile  │        │   not a server)          │
│  in plain language   │ ◄──────│  Profile compiler        │
│  Reviews compiled    │        │  (calls OpenRouter)      │
│  questions           │        │  Saves CompiledProfile   │
└──────────────────────┘        └──────────────────────────┘

 Page time (every matching page)
┌──────────────────────┐        ┌──────────────────────────┐
│  Content script      │        │  Service worker          │
│  (per tab)           │        │                          │
│                      │  msg   │                          │
│  1. Match URL to     │──────► │  4. Build Jev state      │
│     active profiles  │        │  5. Call Jev via         │
│  2. Scan DOM using   │        │     OpenRouter           │
│     profile config   │        │  6. Filter by threshold  │
│  3. Collect          │ ◄──────│  7. Run resolvers        │
│     candidates       │  msg   │  8. Write Automerge doc  │
│  9. Highlight nodes  │        │                          │
└──────────────────────┘        └───────────┬──────────────┘
         ▲                                  │
         │ msg                  ┌───────────▼──────────────┐
┌────────┴─────────────┐        │  IndexedDB               │
│  Side panel          │◄──────►│  (Automerge storage +    │
│  Shows matches for   │        │   chrome.storage.local   │
│  current tab, review │        │   for the API key)       │
│  queue, spend meter  │        └──────────────────────────┘
└──────────────────────┘
```

The service worker is the extension's own background script, defined by Manifest V3. It runs in the browser, not on a server. It exists because content scripts can't make cross-origin requests to OpenRouter and because the side panel may be closed while the user browses.

The content script never holds the API key. The general-purpose LLM is never called at page time.

## Side panel

The side panel is the extension's only UI. It replaces both an options page and a popup. Open it from the toolbar icon or the keyboard shortcut. It stays open while the user browses and updates as the active tab changes.

On Chrome, use the `sidePanel` API. On Firefox, use `sidebar_action`. Both load the same `sidepanel.html`.

### Layout

The panel has four tabs.

| Tab | Contents |
|---|---|
| **This page** | Matches found on the active tab, grouped by profile. Each match shows its text, Jev probability, resolver output (for example, coordinates with a map link), and **Confirm** / **Reject** buttons for items in review. Clicking a match scrolls the page to the node and flashes its highlight. A **Rescan** button re-runs extraction. |
| **Profiles** | List of profiles with an enable toggle and a per-site switch for the current origin (**Always** / **Never** / **Ask**). **New profile** opens the editor inline. |
| **Data** | Browse stored matches by origin and page. Export as JSON or CSV. **Clear site** and **Clear all** actions. Shows Automerge document sizes. |
| **Settings** | OpenRouter API key, compiler model picker, geocoder provider and key, spend meter, and the direct-TypeSafe fallback. |

### Profile editor

The editor is a single scrollable form inside the **Profiles** tab:

1. **Name**
2. **What to extract**: multi-line text.
3. **Where it applies**: a list of match patterns with an **Add current site** shortcut, plus the optional page-type hint.
4. **What to do with matches**: resolver checkboxes with their settings.
5. **Compile** button. Shows a spinner, then the generated questions in a collapsible **Compiled questions** section. Each question's `instructions` and `criteria` are editable text fields.
6. **Test on this page**. Runs the compiled profile against the active tab and renders results in the **This page** tab with an accept-threshold slider. Slider changes re-filter stored answers instantly without calling Jev again.
7. **Save**.

### API key entry

The **Settings** tab has a single password-style field for the OpenRouter key with a **Verify** button that calls `GET https://openrouter.ai/api/v1/auth/key` and shows the key's label and remaining credit. The key is written to `chrome.storage.local` and never leaves the device except in the `Authorization` header to OpenRouter.

Until a key is verified, the **This page** tab shows a short setup prompt and the extension doesn't scan any page.

### First run

On install, the side panel opens automatically to the **Settings** tab with three steps: paste key, pick a built-in profile to enable, and choose whether it applies to all sites or only sites the user adds. Nothing is scanned until step three is complete.

## Extraction profiles

A profile is the unit of user configuration. Users can create as many profiles as they want, and several profiles can apply to the same page.

### User-facing profile

Users fill in four fields in the side panel's profile editor:

| Field | Type | Example |
|---|---|---|
| Name | Text | "Restaurant locations" |
| What to extract | Free text | "Physical addresses and restaurant or cafe names. Include branch locations if the page lists several. Ignore the company's HQ mailing address." |
| Where it applies | URL patterns and optional page-type hint | `*://*.yelp.com/*`, `*://*/locations*`, "pages that list multiple venues" |
| What to do with matches | One or more resolvers | Geocode to lat/lng |

**Where it applies** accepts standard [match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns). A profile with no patterns applies nowhere until the user enables it for the current site from the side panel. Users can also set per-site overrides: **Always run here**, **Never run here**, or **Ask each time**.

The page-type hint is optional free text. The compiler uses it to add a page-level gating question so the profile skips pages that match the URL pattern but not the intent.

### Compiled profile

The profile compiler converts the user-facing profile into a `CompiledProfile`. Users can inspect and edit the compiled output, but they don't have to.

```ts
interface CompiledProfile {
  id: string;
  version: number;
  name: string;
  enabled: boolean;
  scope: {
    matchPatterns: string[];
    siteOverrides: { [origin: string]: "always" | "never" | "ask" };
    pageGate?: JevQuestion;         // optional; asked once per page, not per candidate
    pageGateThreshold: number;
  };
  selection: {
    sources: CandidateSource[];     // which extractors to run, in priority order
    textPatterns?: string[];        // regexes, as strings
    maxCandidates: number;
    contextChars: number;
  };
  questions: JevQuestionTemplate[]; // applied to every candidate
  decision: {
    acceptField: string;            // which question decides acceptance
    acceptThreshold: number;
    reviewThreshold: number;
  };
  resolvers: ResolverConfig[];
  compiler: {
    model: string;                  // OpenRouter model ID that produced this
    compiledAt: string;
    sourceHash: string;             // hash of the user-facing profile
  };
}

type CandidateSource =
  | "structured_data" | "semantic_html" | "map_embeds"
  | "text_patterns" | "headings" | "link_text" | "table_cells" | "list_items";

interface JevQuestionTemplate {
  id: string;                       // "{cid}" is replaced with the candidate ID
  type: "noul" | "choice" | "score";
  instructions: string;             // must reference "candidate {cid}"
  criteria: { [answer: string]: string };
                                    // noul: keys "true" and "false"
                                    // choice: one key per option, max 255
                                    // score: one key per level, 2–10, in order
}

interface ResolverConfig {
  type: "geocode" | "webhook" | "none";
  when: { field: string; equals?: string; in?: string[] };
  config: Record<string, unknown>;
}
```

### Profile compiler

The compiler is a single call to a general-purpose LLM. It runs when the user saves a profile and again if they edit it. It never runs at page time.

**Input:** The user-facing profile fields, plus a fixed system prompt that describes Jev's constraints and the `CompiledProfile` schema.

**Output:** A `CompiledProfile` as JSON. The compiler must return only JSON, and the extension validates it against the schema before saving. If validation fails, retry once with the validation errors appended, then show the errors to the user.

The system prompt instructs the LLM to:

- Write one question per concept. Each question asks exactly one thing and references `candidate {cid}`.
- Prefer `noul` for accept/reject decisions and `choice` for categorization. Use `score` only when the user asks for a ranking or rating.
- Keep questions self-contained. Jev evaluates each question in isolation; it can't refer to another question's answer.
- Encode exclusions the user mentioned as part of the question, not as a separate question. For example, "Ignore the HQ mailing address" becomes "Candidate {cid} is a customer-facing venue location, not a corporate or mailing address."
- Pick `CandidateSource` values that match the target. Addresses need `semantic_html` and `text_patterns`; product names need `headings` and `list_items`.
- Generate a `pageGate` question when the user provided a page-type hint.
- Choose conservative default thresholds: `acceptThreshold: 0.85`, `reviewThreshold: 0.5`.

**Provider.** The compiler calls OpenRouter's chat completions endpoint (`POST https://openrouter.ai/api/v1/chat/completions`). Users pick any OpenRouter-listed model in the side panel's **Settings** tab; the default is a mid-tier model with strong JSON adherence. Set `response_format: { type: "json_object" }` and pass the `CompiledProfile` JSON schema in the system prompt.

Because OpenRouter also hosts Jev, the extension needs exactly one API key for everything. See [Model routing](#model-routing).

**Cost.** One compile is roughly 2,000–4,000 input tokens and 1,000–2,000 output tokens. At current frontier-model prices this is a fraction of a cent, and it happens only when a profile changes.

### Review step

After compiling, the side panel shows the generated questions with a **Test on this page** button. See [Profile editor](#profile-editor). Users can adjust thresholds with a slider and see the effect immediately without recompiling.

Users can also edit question text directly. Edited profiles are marked as **customized**, and the extension won't overwrite the edits on recompile unless the user asks it to.

### Built-in profiles

The extension ships with pre-compiled profiles the user can enable, duplicate, or edit:

- **Locations and businesses**: addresses and venue names, resolved to coordinates.
- **Events**: event names, dates, and venues.
- **Contact details**: email addresses and phone numbers, with a `choice` question for role (sales, support, press, personal).
- **Prices**: product names and listed prices.

Built-in profiles are compiled at build time and shipped as JSON, so they don't require a compile call.

## Model routing

All model traffic goes through OpenRouter with a single user-supplied key. OpenRouter exposes Jev through a dedicated System One endpoint that implements TypeSafe's request and response shapes, so the extension doesn't need a separate TypeSafe account.

| Purpose | Endpoint | Model | When |
|---|---|---|---|
| Profile compiler | `POST /api/v1/chat/completions` | User-selected chat model | Profile save or edit |
| Candidate judging | `POST /api/v1/systemone` | `typesafe/jev-1.13` | Every matching page |
| Page gate | `POST /api/v1/systemone` | `typesafe/jev-1.13` | Every matching page, one question |
| Geocode verification | `POST /api/v1/systemone` | `typesafe/jev-1.13` | After geocoding, if enabled |

Base URL for both endpoints: `https://openrouter.ai/api`. Authenticate with `Authorization: Bearer <OPENROUTER_API_KEY>`.

**Model IDs.** Use the fully qualified `typesafe/jev-1.13` rather than the bare `jev-1.13`. OpenRouter maps bare IDs onto the `typesafe/` namespace, but explicit IDs avoid ambiguity in logs. Don't use `~typesafe/jev-latest` in production; it's a moving alias and will change answers under tuned thresholds.

**Response.** OpenRouter returns TypeSafe's `model`, `answers`, and `usage` fields plus `id`, `provider`, and `usage.cost`. Log `usage.cost` per request to power the in-extension spend meter.

**Fallback.** Allow an advanced option in **Settings** to set `TYPESAFE_BASE_URL` to `https://api.typesafe.ai` with a TypeSafe key for users who already have direct access. The request body is identical; only the base URL, key, and model ID prefix differ.

Note: Jev doesn't run on OpenRouter's chat completions endpoint. Chat SDKs will fail against it. Use the System One endpoint or the `@openrouter/sdk` `systemOne.create` method.

## Components

### Content script

The content script runs on every page at `document_idle`. On load it asks the service worker which profiles apply to the current URL. If none apply, it exits without scanning. Otherwise it's responsible for finding candidates for each active profile and, later, highlighting accepted ones.

#### Profile matching

1. Filter profiles by `enabled` and by `scope.matchPatterns` against the current URL.
2. Apply `scope.siteOverrides` for the current origin. `never` removes the profile; `ask` shows a one-time prompt in the side panel.
3. For profiles with a `pageGate`, the service worker asks the gate question once against a short page summary (title, first heading, first 500 characters of body text). Profiles whose gate probability falls below `pageGateThreshold` are skipped for this page.

#### Candidate extraction

The content script runs only the `CandidateSource` extractors listed in each active profile's `selection.sources`. When several profiles are active, run the union of their sources once and tag each candidate with the profiles it belongs to. The available extractors, in default priority order:

| Source | Selector or method | Why |
|---|---|---|
| Structured data | `script[type="application/ld+json"]` with any `@type`; the compiler lists which types each profile cares about | Highest precision. Often includes coordinates already. |
| Semantic HTML | `<address>`, `[itemtype*="PostalAddress"]`, `[itemprop="address"]` | Explicit author intent. |
| Map embeds | `iframe[src*="google.com/maps"]`, `iframe[src*="openstreetmap"]`, `a[href*="maps.app.goo.gl"]` | URL often contains coordinates or a place ID. |
| Address patterns | Regex over text nodes for street numbers, postal codes, and country names | Catches unstructured addresses. |
| Headings and emphasis | `h1`–`h3`, `strong`, `b`, `[role="heading"]` | Business names often appear here. |
| Link text | `a` elements with `href` to an external domain | Business names commonly link to their own site. |
| Table cells | `td`, `th` | Tabular listings such as price lists and schedules. |
| List items | `li`, `dd` | Bulleted and definition-style listings. |

The `text_patterns` extractor uses regexes from the profile's `selection.textPatterns`, not a fixed address regex. The compiler generates these.

Skip nodes inside `<nav>`, `<footer>`, `<script>`, `<style>`, `[aria-hidden="true"]`, and elements with zero rendered size.

Deduplicate candidates by normalized text. If two nodes have identical text after trimming and lowercasing, keep the one with the richer context.

#### Candidate record

Each candidate is tagged in the DOM with `data-geo-id` and serialized as:

```json
{
  "id": "c17",
  "text": "Blue Bottle Coffee, 66 Mint St, San Francisco, CA 94103",
  "tag": "address",
  "source": "semantic_html",
  "context": {
    "heading": "Our locations",
    "before": "Visit us at any of our three cafes.",
    "after": "Open daily 7am–6pm."
  },
  "hints": {
    "lat": null,
    "lng": null,
    "placeId": null
  }
}
```

- `text`: The node's `innerText`, trimmed and collapsed to single spaces. Cap at 300 characters.
- `context.heading`: The nearest preceding heading, if any.
- `context.before` and `context.after`: Up to `selection.contextChars` (default 120) characters of adjacent visible text.
- `profiles`: IDs of the active profiles whose extractors produced this candidate. Not shown above; added by the content script.
- `hints`: Coordinates or place IDs found in structured data or map URLs. When present, skip geocoding for this candidate.

Cap candidates at the profile's `selection.maxCandidates` (default 200). If a page exceeds the cap, keep candidates in priority order by source.

### Background service worker

The service worker owns the Jev client, the geocoder, and the Automerge repository.

#### Building the Jev state

The state is a JSON array of candidate records, plus a short page descriptor:

```json
{
  "page": {
    "url": "https://example.com/locations",
    "title": "Our locations – Example Co",
    "lang": "en"
  },
  "candidates": [ /* candidate records */ ]
}
```

Jev reads text only. Don't include raw HTML, base64 data, or binary content.

**Size limits.** Jev shares approximately 64,000 tokens across the state and all questions in a request, and the state plus the longest single question must fit in approximately 32,000 tokens. TypeSafe enforces these limits with its own tokenizer. Estimate tokens as `characters / 4` and keep the serialized state under 100,000 characters. If a page exceeds this, split candidates into chunks of at most 50 and send one request per chunk. Include the `page` descriptor in every chunk.

Note: Accuracy degrades as unrelated content fills the state. Sending fewer, well-chosen candidates produces better results than sending everything.

#### Questions

For each active profile, expand every `JevQuestionTemplate` once per candidate, replacing `{cid}` with the candidate ID. Reference candidates by ID so answers map back unambiguously. A profile with two question templates and 40 candidates produces 80 questions.

The example below shows the questions the **Locations and businesses** built-in profile generates for one candidate.

```json
{
  "model": "typesafe/jev-1.13",
  "state": { /* as above */ },
  "questions": {
    "c17_resolve": {
      "type": "noul",
      "instructions": "Does candidate c17 describe a specific physical place or business that could be placed on a map?",
      "criteria": {
        "true": "A street address, named venue, branch location, or landmark.",
        "false": "A person, a product, a region with no specific location, or unrelated text."
      }
    },
    "c17_kind": {
      "type": "choice",
      "instructions": "What does candidate c17 describe?",
      "criteria": {
        "street_address": "A postal address with street and number.",
        "business_name": "The name of a company, shop, or venue without an address.",
        "city_or_region": "A city, state, country, or neighbourhood.",
        "landmark": "A named park, monument, station, or building.",
        "not_a_place": "None of the above."
      }
    }
  }
}
```

Questions are an object keyed by question ID. Each question has `type`, `instructions`, and `criteria`, where `criteria` describes what each possible answer means. The compiler generates the `criteria` text; well-written criteria matter as much as the question itself.

Note: Verify this shape against the current OpenRouter System One reference before implementing. The example is drawn from OpenRouter's SDK documentation and may lag TypeSafe's native API.

Pin the model version. Log the `model` field from every response; OpenRouter returns the model ID that actually served the request.

The compiler is responsible for writing questions that ask one well-scoped thing each. If a user hand-edits a question into a compound condition such as "is a business and has an address," the review step will surface degraded probabilities.

Pin the model version. `jev-latest` resolves to a moving target and can change answers under tuned thresholds. Log the `model` field from every response.

#### Thresholds

Thresholds come from the profile's `decision` block. The answer to `decision.acceptField` is compared against them:

| Probability | Action |
|---|---|
| ≥ `acceptThreshold` | Accept. Run the profile's resolvers whose `when` condition matches. |
| `reviewThreshold` – `acceptThreshold` | Store with `status: "review"`. Show in the side panel's **This page** tab for the user to confirm or reject. |
| < `reviewThreshold` | Discard. |

User confirmations and rejections in the review queue are stored alongside the candidate. A later version can use them to suggest threshold adjustments per profile. Tune default thresholds against a labeled set. See [Evaluation](#evaluation).

#### Rate limits

TypeSafe's published limits for `jev-1.13` are 250,000 tokens per second and 1,200 requests per minute. Both are subject to change. The client must:

- Batch all candidates for a page into as few requests as the size limit allows.
- Retry on HTTP 429 with exponential backoff, honoring `retry-after`.
- Debounce re-scans of the same tab to at most one request per 5 seconds.

#### Resolvers

A resolver is a post-acceptance action configured per profile. Each `ResolverConfig` has a `when` condition evaluated against the candidate's Jev answers, so a profile can, for example, geocode only candidates whose `kind` answer is `street_address`.

Ship with these resolvers:

- **`geocode`**: Resolves text to coordinates. See below.
- **`webhook`**: POSTs the accepted candidate as JSON to a user-supplied URL. Useful for piping results into a spreadsheet or another tool.
- **`none`**: Stores the match with no further action.

##### Geocode resolver

The geocoder is pluggable. Ship with a Nominatim adapter and define an interface for others:

```ts
interface Geocoder {
  resolve(query: string, hints?: { lang?: string; countryBias?: string }):
    Promise<{ lat: number; lng: number; displayName: string; confidence: number } | null>;
}
```

Cache geocoder results by normalized query in `chrome.storage.local` for 30 days.

**Verification step.** Geocoders return wrong matches for ambiguous names. When the resolver config sets `verify: true`, send a second Jev request with the original candidate and the geocoder's `displayName`, asking:

> "The geocoded result matches the place described by candidate c17."

Discard results where this probability is below 0.70.

### Data model

Use `@automerge/automerge-repo` with `IndexedDBStorageAdapter`. Create one document per origin so documents stay small and merges stay cheap.

#### Document schema

```ts
interface ExtractionDoc {
  origin: string;                 // "https://example.com"
  pages: {
    [url: string]: {
      title: string;
      firstSeen: string;          // ISO 8601
      lastSeen: string;
      matches: Match[];
    };
  };
}

interface Match {
  id: string;                     // stable hash of profileId + normalized text + url
  profileId: string;
  profileVersion: number;
  text: string;
  status: "accepted" | "review" | "rejected" | "confirmed";
  answers: {                      // every Jev answer for this candidate, by template ID
    [questionId: string]: { value: string | number | boolean; probability: number };
  };
  model: string;                  // Jev version that answered, e.g. "jev-1.13.0"
  resolved?: {                    // one entry per resolver that ran
    [resolverType: string]: unknown;
  };
  domPath?: string;               // CSS path for re-highlighting
  updatedAt: string;
}

// Example resolved.geocode value
interface GeocodeResult {
  lat: number;
  lng: number;
  provider: string;
  displayName: string;
  confidence: number;
  verified?: boolean;
}
```

Profiles themselves are stored in a separate Automerge document, `ProfilesDoc`, so they can be exported, shared, and eventually synced independently of extracted data.

#### Write rules

- Use `match.id` as the key. Re-visiting a page updates existing matches rather than appending duplicates.
- Never delete matches. Set `status` to `rejected` instead, so merges from other replicas don't resurrect them.
- Store all Jev answers, not only the accept decision. This lets users re-filter stored data with new thresholds without re-running Jev.
- Write in a single `changeDoc` call per page scan to keep history compact.

### Extension manifest

Key `manifest.json` fields:

```json
{
  "manifest_version": 3,
  "permissions": ["storage", "activeTab", "scripting", "sidePanel"],
  "side_panel": { "default_path": "sidepanel.html" },
  "action": { "default_title": "Open Page Extractor" },
  "host_permissions": [
    "https://openrouter.ai/*",
    "https://nominatim.openstreetmap.org/*"
  ],
  "optional_host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }],
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  }
}
```

For Firefox, add `"sidebar_action": { "default_panel": "sidepanel.html", "default_title": "Page Extractor" }` and drop `sidePanel` from `permissions`. In the service worker, call `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` on Chrome so the toolbar icon opens the panel.

Request `<all_urls>` as an optional permission and prompt for it only when the user creates a profile whose match pattern needs it. Webhook resolvers pointing at custom domains, and the direct-TypeSafe fallback, also request host permission at configuration time.

Automerge ships as WebAssembly. Bundle the `.wasm` file with the extension and load it locally. Manifest V3's content security policy blocks fetching it from a CDN. The `'wasm-unsafe-eval'` directive is required.

## Message protocol

Messages between the content script and service worker use `chrome.runtime.sendMessage`.

| Direction | Type | Payload |
|---|---|---|
| Content → Background | `GET_ACTIVE_PROFILES` | `{ url }` |
| Background → Content | `ACTIVE_PROFILES` | `{ profiles: CompiledProfile[] }` |
| Content → Background | `CANDIDATES` | `{ url, title, lang, candidates: Candidate[] }` |
| Background → Content | `RESULTS` | `{ url, matches: Array<{ id, profileId, domPath, status }> }` |
| Side panel → Background | `GET_PAGE` | `{ tabId }` |
| Background → Side panel | `PAGE` | `{ url, matches: Match[] }` — also pushed whenever a scan completes for the active tab |
| Side panel → Background | `RESCAN` | `{ tabId }` |
| Side panel → Content | `FOCUS_MATCH` | `{ matchId, domPath }` |
| Side panel → Background | `REVIEW` | `{ matchId, decision: "confirmed" \| "rejected" }` |
| Side panel → Background | `SITE_OVERRIDE` | `{ profileId, origin, mode }` |
| Side panel → Background | `COMPILE_PROFILE` | `{ profile: UserProfile }` |
| Background → Side panel | `COMPILED` | `{ compiled: CompiledProfile, warnings: string[] }` |
| Side panel → Background | `TEST_PROFILE` | `{ compiled: CompiledProfile, tabId }` |
| Side panel → Background | `SET_KEY` | `{ key }` |
| Background → Side panel | `KEY_STATUS` | `{ valid, label?, credit? }` |

The side panel reads the Automerge documents directly from IndexedDB for the **Data** tab rather than routing every read through the service worker. Both contexts open the same `Repo` with the same storage adapter; Automerge handles concurrent access.

## Cost

Jev bills input tokens only at $0.042 per million. Output is free. Cost scales with the number of active profiles per page, because each profile adds its questions to the request, but questions are cheap relative to the shared state.

| Scenario | Pages/hour | Tokens/page | Tokens/hour | Cost/hour |
|---|---|---|---|---|
| Light browsing, 1 profile | 30 | 4,000 | 120,000 | $0.005 |
| Typical, 2 profiles | 60 | 9,000 | 540,000 | $0.02 |
| Heavy, 4 profiles, with verification | 120 | 18,000 | 2,160,000 | $0.09 |

The profile compiler adds a one-time cost per profile save, typically under $0.02 depending on the chosen chat model, and zero for built-in profiles. OpenRouter reports `usage.cost` on every response, so the extension can show an exact running total without estimating.

Geocoding cost depends on the provider. Nominatim is free with a one-request-per-second policy. Commercial geocoders typically cost more per hour than Jev does.

## Security and privacy

- **The OpenRouter key** lives only in the service worker, stored with `chrome.storage.local`. Never inject it into page context. Recommend in the **Settings** tab that users create a dedicated OpenRouter key with a spend limit for this extension.
- **Page content** is sent to OpenRouter, which forwards it to TypeSafe, only on pages where at least one profile is active. Nothing is sent from pages that match no profile. Show this in the side panel's first-run flow.
- **Profile text** is sent to the user's chosen chat model through OpenRouter at compile time. Page content is never sent to a chat model.
- **Provider data policies.** OpenRouter lets users restrict routing to providers with specific data-retention policies. Link to the relevant OpenRouter account setting from the **Settings** tab rather than reimplementing it.
- **Scope is the privacy control.** The default for a new profile is no match patterns, so it runs nowhere until the user adds a pattern or enables it for a site. Per-site `never` overrides beat every pattern.
- **Sensitive pages.** Skip scanning on pages whose URL matches banking, healthcare, email, or authentication patterns, and on any page served with `Cache-Control: no-store`.
- **Local data.** All results stay in IndexedDB unless the user exports them. Provide **Clear site** and **Clear all** actions in the side panel's **Data** tab.

## Evaluation

Before tuning thresholds or shipping, build a labeled set:

1. For each built-in profile, collect 100–200 pages across categories where it should and shouldn't match. For the locations profile: restaurant listings, news articles, corporate "contact us" pages, event pages, and pages with no places.
2. Hand-label every candidate the extractor proposes as `match` or `not_match` per profile, and record the correct resolver output where applicable.
3. Run the pipeline and compute precision and recall at several thresholds.
4. Record Jev's `model` field with each run so results are reproducible when the model updates.

Target for v1 built-in profiles: precision ≥ 0.90 and recall ≥ 0.80 at the default threshold.

Also evaluate the compiler: give it 20 varied user-written profiles, and check that every output validates against the schema and that a reviewer rates the generated questions as faithful to the user's intent.

Note: TypeSafe's published speed and cost figures are the company's own benchmarks. Validate latency and accuracy on your own traffic.

## Open questions

- Which OpenRouter chat model should be the compiler default? Needs a small bake-off on question quality versus cost.
- Should we use OpenRouter's provider routing preferences to pin Jev to a specific region for latency?
- When Jev ships a new version, should compiled profiles be re-tested automatically, and should the user be prompted before switching?
- Should profiles be shareable as URLs or files, and if so, how do we handle a shared profile that includes a webhook resolver?
- Do we re-scan on DOM mutation for single-page apps, or only on navigation events?
- Should the side panel support multiple keys (one per profile) so users can split billing?
- Which sync transport, if any, for the Automerge documents in a future version?

## References

- TypeSafe AI documentation: https://docs.typesafe.ai
- OpenRouter System One API: https://openrouter.ai/docs/client-sdks/typescript/sdks/systemone/README
- OpenRouter TypeSafe SDK guide: https://openrouter.ai/docs/guides/community/typesafe-sdk
- OpenRouter Jev model page: https://openrouter.ai/typesafe/jev-1.13
- Automerge Repo: https://automerge.org/docs/repositories/
- Chrome extension Manifest V3: https://developer.chrome.com/docs/extensions/develop/migrate
- Chrome Side Panel API: https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- Firefox sidebar_action: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/sidebar_action
- Nominatim usage policy: https://operations.osmfoundation.org/policies/nominatim/
