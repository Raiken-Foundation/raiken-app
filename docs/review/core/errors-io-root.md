# Core Review — errors / io / artifacts / root files

**Scope:** `libs/core/src/errors/` (6 files, 592 ln) · `io/atomic-write.ts` (18 ln) · `artifacts/` (2 files, 15 ln) · root `index.ts`/`types.ts`/`utils.ts` (630 ln)
**Method:** direct line-by-line read (agent delegation failed twice; reviewed in-session). Report-first — no changes made.

## Findings

| Severity | Location | Issue | Why it matters | Fix direction |
|---|---|---|---|---|
| medium | libs/core/src/errors/redact.ts:10-20 | Secret-value patterns cover LLM provider keys (sk-, AIza, gsk_, pplx-, xai-, Bearer, Basic) but NOT JWTs (`eyJ…`), AWS `AKIA…`, GitHub `ghp_`/`github_pat_`, GitLab `glpat-` | Raiken handles browser auth sessions (cookies/storage states) where JWT-bearing values realistically reach error text; unredacted JWTs would flow to client payloads | Add patterns for eyJ-prefixed JWTs, AKIA[0-9A-Z]{16}, ghp_[A-Za-z0-9]{36}, github_pat_, glpat- |
| medium | libs/core/src/errors/normalize.ts:48-58 | `isLockConflict` classifies errors by substring-matching human messages ("already running", "already active…") | Message edits anywhere upstream silently change the error code/exit-code contract; fragile cross-package coupling | Prefer a `code`/brand on the source errors (PathContainmentError already does this) over string matching |
| low | libs/core/src/errors/raiken-error.ts:31-44 | `withMetadata` constructs a NEW RaikenError — original stack is replaced by the re-wrap site (cause chain keeps it, but top stack misleads) | `normalizeToRaikenError` calls withMetadata on every normalized error when correlation ctx exists, so stacks point at normalize, not origin | Copy `error.stack` onto the new instance in withMetadata |
| low | libs/core/src/errors/normalize.ts:173 vs raiken-error.ts:125 | `defaultCodeForCategory("conflict")` → `OPERATION_BUSY`, but `conflictError` default code is `RESOURCE_CONFLICT` | Two different "default" codes for the same category depending on path; API consumers see inconsistent codes | Align one as the canonical default |
| low | libs/core/src/io/atomic-write.ts:13-14 | Temp-file + rename, but no `fsync` of file/dir before rename | Crash/power-loss can leave a truncated or empty target (config, state files) | fsync tmp before rename (optionally dir after) |
| note | libs/core/src/io/atomic-write.ts:14 | Rename replaces target; permissions/mode of existing file not preserved | Rewritten config files lose custom modes | Stat + chmod after rename |
| note | libs/core/src/artifacts/project-artifact-service.ts:11-13 | `read()` returns whole file as Buffer with no size cap | A large video/trace artifact loads fully into memory per request | Stream responses above a threshold |
| low | libs/core/src/utils.ts:42-50 | `formatBytes` no negative-input guard → `NaN undefined` output | Cosmetic-only today (no negative callers found) | Guard `bytes <= 0` |
| low | libs/core/src/utils.ts:255-259 | IPv4 extraction accepts invalid octets (e.g. 999.999.999.999:3000) | Invalid URL flows into discovery as if valid | Validate octets 0-255 |
| low | libs/core/src/utils.ts:129-133 | `hardenNavigationWaits` doesn't rewrite `waitForLoadState('networkidle', {…})` (2-arg form) | Rare but leaves a never-settling wait in generated code | Extend regex to allow trailing args, or flag in doctor |
| note | libs/core/src/utils.ts:33-40 | `countLines` counts trailing newline as a line; error → 0 indistinguishable from empty file | Stats-only usage; negligible | Return -1/throw option if ever used for logic |
| note | libs/core/src/utils.ts:189-223 | `scanDirectoryForPattern` name says pattern, does case-insensitive substring; symlinked dirs silently skipped | Mildly misleading API; symlinked fixture dirs invisible to scan | Rename to `scanDirectoryForSubstring`; decide symlink policy explicitly |
| note | libs/core/src/errors/redact.ts:11-13 | `sk-or-v1-…`/`sk-ant-…` patterns are subsumed by the generic `sk-…{8,}` pattern | Redundant but harmless | Drop or keep for documentation value |

Clean: `errors/types.ts` (taxonomy well-designed, codes documented as stable), `errors/serialize.ts` (key- and value-level redaction correct incl. arrays), `errors/index.ts` barrel (complete), root `index.ts` barrel (all 25 modules present, orchestrator deliberately named-only, no export collisions — build passes), `utils.cleanGeneratedTestCode` (multi-fence selection heuristic is well-reasoned and tested per audit).

## Strengths
- Error taxonomy is genuinely production-grade: stable codes, categories, retryable defaults per category, cause chains kept out of client payloads.
- redactSecrets applied at BOTH message and structured-detail layers, with a leaf-module design that avoids import cycles.
- `cleanGeneratedTestCode` — one shared cleaner for every save path, with the multi-fence "most testish block" heuristic documented inline.
- `isBinaryFile` error path chooses skip-and-warn over feeding unreadable bytes to a parser, with rationale comment.

## Test-coverage observations (from spec skim)
- No spec asserts redaction of JWT/AKIA/ghp_ shaped values (matches the gap above).
- `hardenNavigationWaits` specs cover single-arg goto + bare networkidle; the 2-arg waitForLoadState form is untested.
- `atomic-write` has no crash-mid-write/torn-file spec (hard to test, but a rename-visibility test would pin the contract).

## Verdict
**minor fixes needed** — the layer is well-built; the redaction pattern gap and message-string coupling in conflict detection are the only items with real-world exposure.
