# Raiken QA fixes — implementation record

Dogfood-QA pass against the playground (v0.6.3) surfaced 13 findings; this doc
records the implemented fixes (P0 + P1) and the deferred follow-ups (P2).

## Implemented

### F1 — `cover` no longer overwrites existing specs (data loss)
- `libs/core/src/cover/cover.ts`: new `force` option; write step refuses with a
  clear error (naming `--output`, `--fix-config`/`doctor --fix`, or `--force`)
  when the target exists with different content. Identical content still writes.
- `apps/cli/src/commands/cover.ts` + `apps/cli/src/bin.ts`: `--force` flag.
- Verified: narrow testMatch steering onto `workflows.spec.ts` refused (exit 2,
  file untouched); `--force` overwrote.

### F2 — `repair --json` emits the diff in CI / non-TTY
- `apps/cli/src/commands/repair.ts`: the non-TTY bail now falls through to the
  declined-apply JSON emit when `--json` is set (README contract: "diff included
  when not applied"). Verified: `repair --json` exits 0 with `{repaired: true,
  applied: false, diff}`.

### F3 — auth/origin mismatch chain
- **F3a** `--domain` help text documents the https assumption; `importFromFlags`
  prints `Assuming https:// for "<domain>" …` when a scheme was omitted
  (`apps/cli/src/bin.ts`, `apps/cli/src/commands/auth.ts`).
- **F3b** new `describeStorageStateOriginMismatch(projectPath, seedUrl)` helper
  (`libs/core/src/config/auth-state.ts`); wired into the post-auth crawl
  (`discoverWithSession`) and `raiken discover` — warns before a crawl that
  would run signed out. Verified both directions.
- **F3c** new doctor rule `auth-state-origin-mismatch`
  (`libs/core/src/doctor/scan.ts`, per-spec, warning, suggests the re-import
  command). Repair now prints the mismatch and prepends an `[ENVIRONMENT]` note
  to the diagnosis prompt (`apps/cli/src/commands/repair.ts`). Verified: the
  exact QA scenario (5173 state vs 5180 baseURL) is now caught at every layer.

### F4 — one-shot agent can browse live pages
- `libs/core/src/agent/graph/graph.ts`: `targetUrl` (set by the classifier) now
  routes to the navigate node unless the tool is `discoveryRead`.
- `libs/core/src/agent/graph/nodes/context.ts`: `answerQuestions` self-heals for
  weak classifiers — best-effort `navigateTo` + `captureCurrentPage` when the
  prompt implies a live page and no DOM was captured; failure degrades to the
  old code/discovery-only answer.

### F5 — draft-assessor false negatives
- `libs/core/src/cover/intent-coverage.ts`: meta stopwords (draft, write,
  create, playwright, test/spec/suite, …), `cleanScenarioDescription()` strips
  imperative wrappers ("draft a playwright test: X"), and `test()`/`describe()`
  titles count as draft signal. Verified: both QA repro prompts pass; "add a
  test user" is not mis-stripped.

### F8 — test failures keep the locator call log
- `apps/cli/src/commands/test.ts`: `CliRunFailure` gains `error` (message,
  truncated at 30 lines) in `--json`; human error limit raised 12 → 30.
  Verified: JSON now carries "Call log:" for locator timeouts.

### F10a — no more `authenticated_entry_url = about:blank` memory pollution
- `libs/core/src/agent/graph/nodes/auth-entry.ts`: `isContentRoute` rejects
  non-http(s) protocols. New spec `auth-entry-memory.spec.ts`.

### F11 — `organize --json` redacts the API key
- `apps/cli/src/commands/organize.ts`: `redactSecrets()` applied to all JSON
  emits; `cleanedConfig.ai.apiKey` is never echoed.

### F12 — `resume` with no sessions — no-op
- Already handled by `bootstrap.ts` ("No saved sessions to resume — starting a
  fresh one."); the QA observation was truncated output (`head -3`).

## Deferred (P2)
- **F6** cold-start `test --list` hang: not reproduced warm; needs instrumented
  repro.
- **F7** `knowledge` mixes origins in one list: group by origin in
  `apps/cli/src/commands/knowledge.ts`.
- **F9** `trace` finds no covering tests: code graph doesn't link e2e specs to
  source; separate feature. (The reported exit-code inconsistency was a
  measurement artifact — trace.ts is consistent.)
- **F10b** `selector_history` not written by CLI repair: agent-only by design.
- **F13** cosmetic logging (crawlee INFO contradiction, duplicated error line,
  `knowledge blockers` auth list).

## Notes
- Tests: core + cli suites green; typecheck green; Biome clean on touched files
  (the repo's remaining `pnpm check` failures are pre-existing WIP formatting).
- The playground's deliberately-narrow `testMatch` (`workflows.spec.ts`) remains
  as it was; `doctor --fix`/`cover --fix-config` are the intended remedies.
