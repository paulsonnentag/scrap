# Page Extractor

A Chrome and Firefox (Manifest V3) extension that extracts user-defined data from web pages, optionally resolves it with external services such as a geocoder, and stores the results locally in [Automerge](https://automerge.org) documents.

Users describe **what** to extract and **where** in plain language. A general-purpose LLM compiles that description once into a set of typed questions for **Jev**, TypeSafe AI's System One decision model. At page time only Jev runs: the content script proposes candidate DOM nodes and Jev answers the compiled questions about each one.

There is no backend. The OpenRouter API key, all configuration, and all extracted data stay in the browser. The full design is in [`docs/SPEC.md`](docs/SPEC.md).

## How it works

1. **Configure.** In the side panel, write a profile: what to extract, which sites, and what to do with matches. The profile compiler (one OpenRouter chat-completion call) turns it into a `CompiledProfile`: candidate sources, regexes, Jev question templates, thresholds, and resolvers. You can review and edit the generated questions, then test them on the current page.
2. **Propose.** On a page that matches an enabled profile, the content script runs the profile's extractors (JSON-LD, `<address>`, map embeds, text regexes, headings, external links, table cells, list items), skips `nav`/`footer`/hidden nodes, dedupes, and caps the list.
3. **Judge.** The service worker builds a Jev state (page descriptor + candidates), expands every question template per candidate, chunks to stay under the context limit, and calls `POST /api/v1/systemone` on OpenRouter with the pinned model `typesafe/jev-1.13`.
4. **Resolve and store.** Answers above `acceptThreshold` run the profile's resolvers (Nominatim geocoding with optional Jev verification, webhook, or none). Everything, including every Jev answer, is written to a per-origin Automerge document in IndexedDB. Borderline results land in a review queue in the side panel.

Four profiles ship pre-compiled: **Locations and businesses**, **Events**, **Contact details**, and **Prices**.

## Development

```sh
npm install
npm run check        # typecheck + unit tests + Chrome build
npm run build        # → dist/          (Chrome)
npm run build:firefox# → dist-firefox/  (Firefox)
npm run watch        # rebuild on change (Chrome target)
```

Load `dist/` as an unpacked extension at `chrome://extensions` (Developer mode → *Load unpacked*). For Firefox, load `dist-firefox/manifest.json` from `about:debugging#/runtime/this-firefox`.

The build is a small [esbuild](https://esbuild.github.io) script (`scripts/build.mjs`) that produces three bundles from `manifest.base.json`:

| Bundle | Entry | Format | Notes |
|---|---|---|---|
| `background.js` | `src/background/index.ts` | ESM module worker | No top-level await; Automerge's wasm is loaded explicitly from `automerge.wasm`. |
| `content.js` | `src/content/index.ts` | IIFE | Runs at `document_idle` on `<all_urls>`, never holds the API key. |
| `sidepanel.js` | `src/sidepanel/main.ts` | IIFE | Vanilla TypeScript, no framework. |

### Layout

```
src/
  shared/        types, message protocol, match patterns, schema (zod), pure Jev logic, hashing, sensitive-URL rules
  content/       DOM helpers, candidate extractors, scan/highlight loop
  background/    storage, OpenRouter client, Automerge repo, compiler, scan pipeline, resolvers, built-in profiles
  sidepanel/     panel state + the four tabs (This page, Profiles, Data, Settings)
test/            vitest unit tests (pure logic in node, extractors under jsdom)
docs/SPEC.md     the specification this implements
```

### Tests

```sh
npm test
```

Covers match-pattern semantics, sensitive-URL rules, question expansion and chunking, answer normalization and thresholds, the compiled-profile schema (all built-ins validate), stable match ids, and the DOM extractors against a fixture page.

## Setup for users

1. Open the side panel (toolbar icon or `Alt+Shift+E`). On first install it opens automatically.
2. Paste an OpenRouter key and click **Verify**. Create a dedicated key with a spend limit; it is stored in `chrome.storage.local` and only ever sent to `openrouter.ai` in the `Authorization` header.
3. Pick a built-in profile and choose whether it runs on all sites (requests the optional `<all_urls>` permission) or only sites you add.

Nothing is scanned until step 3 is done. The **Settings** tab shows a running spend meter fed by OpenRouter's `usage.cost` field.

## Privacy model

- Page content leaves the browser only for pages where at least one profile is active, and only to OpenRouter (which forwards to TypeSafe). Profile text goes to your chosen chat model at compile time. Page content never goes to a chat model.
- A new profile has no match patterns and therefore runs nowhere until you add a pattern or flip the per-site switch. Per-site **Never** beats every pattern.
- Banking, healthcare, mail, and authentication URLs are skipped by heuristic, as are pages the service worker observes being served with `Cache-Control: no-store` (this needs host permission for the site). An explicit per-site **Always** override bypasses the host heuristic for that origin.
- Data lives in IndexedDB. The **Data** tab exports JSON/CSV and has **Clear site** / **Clear all**.

## Dumping raw diagnostics

When a page produces nothing, the extension can hand over everything it saw, verbatim. Nothing is summarized or interpreted.

Press **Dump** on the **This page** tab (or **Dump raw data** under *Raw dump* in **Settings**), then **Copy dump**. You get one markdown document containing:

- **Scan trace** as JSON: the setup state, every profile with whether its patterns matched and its per-site override, the page-gate probability, per-source extractor counts, every candidate with its text, source, DOM path and hints, and for each candidate the normalized answers, accept probability and resulting status.
- **Jev calls**: for each System One request, the **exact JSON body POSTed** and the **exact body received**, with the HTTP status and duration. This is the ground truth for anything involving answers, probabilities or response shape.
- **Profiles** as stored, in full, so question wording, criteria and thresholds are visible.
- **Event log** and **page source** as the extractors saw it.

Downloads are available as `.md` or as raw `.json`. Inline script and style bodies in the page source are replaced with placeholders by default, while JSON-LD is kept verbatim since the structured-data extractor reads it; tick *Keep script and style bodies* for the unfiltered version.

Request and response bodies are kept up to 256 KB each for the last 12 calls, and truncation is marked inline. Anything matching an API-key pattern is stripped, but the dump contains the page's URL and content, so read it before sharing.

## Assumptions to verify before shipping

The spec notes that the System One request/response shape should be checked against OpenRouter's current reference. The client sends `{ model, state, questions }` and reads `answers[questionId]`. `normalizeAnswer` in `src/shared/jev.ts` accepts `{ value, probability }` as documented, plus `{ answer, confidence }`, a `probabilities` distribution, and a bare probability, so a small shape drift degrades gracefully rather than failing. `usage.cost` and the `model` field from each response feed the spend meter and match records.

Other things worth checking on real traffic:

- Default compiler model (`openai/gpt-4.1-mini`) versus alternatives, per the spec's open question.
- Threshold defaults (`0.85` accept, `0.5` review) against a labeled set, per the spec's **Evaluation** section.
- Nominatim's usage policy (1 request/second, identifying Referer) if you expect heavy geocoding; the resolver throttles and caches for 30 days.

## Not in scope for v1

Automerge sync between devices, hosted services of any kind, LLM calls at page time, and text generation. See the spec's **Non-goals** and **Open questions**.
