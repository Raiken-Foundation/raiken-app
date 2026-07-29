# Repo Analysis + SSO Handoff

Read this file first. It is self-contained: a new session should not need prior chat context.

The separate accuracy-remediation workstream is complete and permanently gated by `pnpm verify`.
This file covers the remaining analysis and SSO workstream.

## Why this work exists

An audit of what Raiken can actually test surfaced two gaps that were worse than "a feature is
missing":

1. **Repo-side analysis was Babel-only, and silently so.** `.vue`/`.svelte` were deliberately
   excluded from the extension allowlist because Babel throws on `<template>`, so SFCs were indexed
   as nodes with an empty symbol table. Since keyword search is built from parsed function and class
   names, an unparsed file was reachable only by a path-token match and contributed nothing to the
   prompt. No source-derived selector extraction existed anywhere in `libs/core/src/analysis/` — not
   one `data-testid` read — so a Django, Rails, or Laravel repo contributed nothing at all, even
   though its templates hold exactly the test ids and labels E2E generation needs.

2. **SSO has three dead config fields rather than a missing algorithm.**
   `auth.customLoginScript` is in the schema, is described in the dashboard as being for "SSO, MFA,
   etc.", and is never executed. `credentials.usernameEnv` / `passwordEnv` are never read, though the
   generation prompt instructs the model to read secrets from environment variables. Two real bugs
   sit alongside them: the agent's `saveAuthState` tool hardcodes `.raiken/auth-state.json` and
   ignores a configured `storageStatePath`, and nothing validates cookie expiry before loading a
   session, so a stale state file yields a confusing unauthenticated run instead of "re-run
   `raiken auth`".

## Agreed scope

Decided with the user; do not widen without asking.

| Area | In scope | Explicitly out of scope |
|---|---|---|
| Analysis | Vue/Svelte SFC parsing; language-agnostic template selector extraction (HTML/Jinja/ERB/Blade/Handlebars/EJS/Twig/Astro); wire both into file search and the prompt | tree-sitter or any real multi-language AST (Python/Ruby/Go symbols and routes) |
| SSO | Execute `customLoginScript`; wire credential env vars; session-expiry preflight; fix the `saveAuthState` path bug | Automated login against Google/Okta/Auth0/Microsoft; IdP-host pause; generated Playwright auth setup project |

The rejected SSO options were declined on purpose: scripting a third-party IdP's login pages is
fragile in exactly the way Batch 4 was about eliminating. The deterministic escape hatches are the
supported path.

## Status

### Done and verified — analysis (part 1 of 2)

All new and changed tests pass; `pnpm check`, the ESLint boundary config, and
`nx run-many -t typecheck` are clean across all six projects.

New modules under `libs/core/src/analysis/`:

- **`masking.ts`** — `maskMatches` / `maskOutside`. Blanks regions while preserving every newline, so
  offsets and line numbers in the masked copy still match the original file. This is what lets one
  Babel parse cover both `<script>` blocks of a Vue SFC and still report true file lines.
- **`sfc.ts`** — `sfcFlavor`, `splitSfc`, `sfcScriptFilename`. Splits an SFC into a line-aligned
  script half and markup half. Handles `<script setup>`, multiple script blocks, `lang="ts"`
  detection, Svelte (whose markup has no `<template>` wrapper), and drops `<style>`.
- **`markup-selectors.ts`** — `MARKUP_EXTENSIONS`, `isMarkupFile`, `hasScannableMarkup`,
  `extractTemplateSelectors`, `describeTemplateSelectors`. Regex-based on purpose: it must survive
  seven template dialects interleaved with HTML.
- **`source-analysis.ts`** — `classifySourceFile`, `analyzeSourceFile`, `SCRIPT_EXTENSIONS`. One entry
  point routing each file to the analyzer that can read it, degrading to the parts that worked.

Design rules encoded in those modules, worth preserving:

- **Only literal attribute values are recorded.** `data-testid="{{ row.id }}"`,
  `<%= dom_id(task) %>`, `task-#{id}`, `:data-testid="rowId"`, `v-bind:`, `[attr.data-testid]`, and
  `x-bind:` are all rejected. A computed value would hand the model a string that never appears in a
  real page — the same honesty principle as Batch 3 grounding.
- Comments are masked before scanning (HTML, Jinja, Blade, Django/Liquid, ERB), as are `<script>` and
  `<style>` islands, so commented-out or JS-string markup cannot advertise a selector.
- Four kinds only: `testId`, `label` (from `aria-label`), `placeholder`, `role`. `testId` records
  which attribute supplied it (`data-testid`, `data-test`, `data-test-id`, `data-cy`, `data-qa`),
  because a `data-cy` project needs `testIdAttribute` configured before `getByTestId` works.
- Capped at 60 selectors per file, prioritised `testId` → `label` → `placeholder` → `role`, so one
  enormous template cannot crowd out the prompt or the index.
- An SFC whose script block is broken still returns its template selectors.

Changed files:

- **`libs/core/src/types.ts`** — added `TemplateSelector` and optional `ParsedFile.templateSelectors`.
  Chosen deliberately: `ParsedFile` is serialised wholesale into the `files.parsed_ast` column and
  re-parsed by `gatherContext`, so this persists end to end with **no DB migration**.
- **`libs/core/src/analysis/code-graph.ts`** — `.vue`/`.svelte` added to the default `extensions`
  (which also makes `import Foo from './Foo.vue'` resolve to a graph edge); `parseFile` now dispatches
  through `analyzeSourceFile` and also analyses markup files; `buildKeywordIndex` indexes selector
  tokens. The old "intentionally excluded" comment is replaced.
- **`libs/core/src/analysis/project-context.ts`** — `extractKeywordsFromNode` indexes selector tokens
  too, so a file edited during a watch keeps the same searchability as a full scan.
- **`libs/core/src/agent/prompts.ts`** — `ContextData.files[].templateSelectors`; new shared
  `formatSourceFiles()` used by both the generation and explain prompts; a `Template selectors:` line
  per file; and one conditional `[RULES]` line stating that source markup shows naming but only
  `[LIVE DOM CONTEXT]` proves an element exists, so the DOM wins. **Batch 3 grounding was left
  untouched on purpose** — source-derived ids must not count as verified DOM.
- **`libs/core/src/agent/agent.ts`** — `readTemplateSelectors` / `buildFallbackContext` helpers;
  selectors carried through all four context-building sites. For a template (no AST) the context text
  now leads with distilled selectors plus a 2000-char markup slice, instead of a 5000-char raw slice
  of mostly layout.
- **`libs/core/src/analysis/index.ts`** — re-exports the new modules.

Tests:

- `libs/core/src/analysis/__tests__/markup-selectors.spec.ts` (22 tests) — per-dialect rejection of
  computed values, comment and code-island masking, line accuracy, dedupe, the cap, and grouping.
- `libs/core/src/analysis/__tests__/source-analysis.spec.ts` (16 tests) — line-aligned splitting,
  `lang="ts"`, Svelte, broken-script degradation, markup-only files, unchanged script behaviour.
- `libs/core/src/__test__/code-graph.spec.ts` — **contract deliberately flipped.** The old test
  asserted a `.vue` file gets no AST; it now asserts SFCs produce symbols and selectors, that a
  template produces selectors but no AST or symbols, and that a selector-only template is findable via
  `findRelevantFiles("delete workspace flow")`.

### Done and verified — SSO (part 2 of 2)

- **One auth-state contract.** `libs/core/src/config/auth-state.ts` now owns configured/default path
  resolution and inspection. An explicit configured path is authoritative, project containment is
  enforced, and missing, malformed, empty, valid, and provably expired state are distinguished.
  Browser startup, discovery, authenticated entry, generated-test state injection, interruption
  recovery, manual handoff, and Doctor all use that contract.
- **No split-brain writes.** The agent `saveAuthState` tool and both handoff surfaces write to
  `auth.storageStatePath`; they no longer hardcode `.raiken/auth-state.json`.
- **Scripted SSO login.** `libs/core/src/browser/custom-login-runner.ts` executes
  `auth.customLoginScript` through the project's own Playwright installation. It creates a
  mode-`0600` temporary spec inside Playwright's actual `testDir`, validates project-contained paths,
  passes `{ page, context, credentials }`, writes state to a temporary sibling, validates it, replaces
  the destination, and cleans up. `raiken auth` uses the configured script by default and supports
  `--script`, `--manual`, `--headed`, and `--timeout`.
- **Credential env vars are live.** `usernameEnv` / `passwordEnv` are resolved at runtime, mapped only
  to observed identity/password fields (never OTP fields), reused across multi-step interruption
  flows, and named in generated login-test guidance. Literal compatibility values remain supported,
  but environment values take precedence.
- **Secret-bearing tool calls are redacted.** Text-entry values and secret-shaped keys are removed
  before tool callbacks, CLI rendering, and run traces while the original arguments still reach the
  browser action.
- **Deterministic fixture coverage.** `tools/playground-auth` now has a configured TypeScript custom
  login script and credential env names. The integration test runs the real fixture via Playwright and
  verifies that the resulting state contains its authenticated session cookie.

### Verification commands

```bash
pnpm verify
```

The full gate passed on 2026-07-29: static checks, boundaries, all project typechecks and unit
suites, the CLI build, browser-backed integration tests, and five retry-free runs of the ten-test
authentication golden suite. `core:test` first returned Nx's known no-diagnostics intermittent
failure, then passed both an isolated verbose retry and the full gate retry; Nx flagged the task
itself as flaky.

## Remaining known limits (do not paper over)

- Selector extraction is regex-based and literal-only by design. Dynamic ids are invisible, and that
  is the correct behaviour.
- Non-JS/TS backends still yield **no symbols or routes** — only template selectors. Python, Ruby, Go,
  and PHP logic remains unparsed, per the agreed scope.
- Source-derived selectors are prompt context only. They do not satisfy Batch 3 grounding, so a
  generated locator whose id exists in source but not in the captured DOM still lands in `unverified`.
  The Batch 3 follow-up (capture does not enumerate `[data-testid]` on non-interactive elements)
  remains open and is the reason those two facts do not yet meet.
- Everything in both workstreams is validated against one deterministic fixture,
  `tools/playground-auth`. "Supported" means proven there, not proven broadly.
