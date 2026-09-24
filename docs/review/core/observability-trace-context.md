# Core Review — observability / trace / context

**Scope:** `libs/core/src/observability/` (7 files) · `trace/` (2 files) · `context/` (2 files), ~1,138 lines
**Method:** delegated line-by-line review (all 11 source files read fully; specs skimmed; CLI commands + graph-query/db collaborators checked for contract). Report-first — no changes made.

## Findings

| Severity | Location | Issue | Why it matters | Fix direction |
|---|---|---|---|---|
| high | libs/core/src/context/builder.ts:206-211 | `errorMessage` from `test_outcomes` (raw Playwright error text, stored unredacted) is written into raiken.ctx.md with only pipe/newline escaping — `redactString` from ../observability/redaction is never applied (also testName:210, testFile:211) | raiken.ctx.md is designed to be handed to external IDE AI agents; Playwright failure text routinely contains `?token=`/`api_key=` URLs, auth headers, storage-state content — the module's biggest secret-leak surface bypasses its own redaction utility | Apply `redactString()` to testName/errorMessage (and scope/projectName) before formatting |
| medium | libs/core/src/context/builder.ts:211 (also 63, 144, 176, 260) | Markdown injection: `err` not in a code span; backticks never escaped in testName/testFile/paths; `projectName` interpolated raw with newlines | Page-controlled content flows into failing assertions → hostile page can inject instructions/links into a file AI agents consume (prompt-injection chain); backtick in testName breaks the table | Escape backticks, strip newlines in interpolated strings, wrap err in a code span |
| medium | libs/core/src/trace/trace.ts:165-181 | Windows paths: `path.isAbsolute("C:\\…")` is false on POSIX → Windows-origin frames resolved as relative and never match; `path.relative` yields backslash paths vs forward-slash `relative_path` matched by exact SQL `IN` (symbols.repository.ts:270) | `raiken trace` silently returns zero matches on/for Windows paths plus a misleading "wrong repo" warning | Detect drive-letter/UNC prefixes as absolute; normalize to posix separators before graph queries |
| medium | libs/core/src/observability/logger.ts:99 | `ensureCorrelationId()` return value discarded; with no ALS scope active, events ship with NO correlationId while a fresh random id is thrown away per event | CLI startup / config loading / early errors — the failure paths you most want correlated — are uncorrelatable | Capture the return and default it into the event when input.correlationId is absent |
| medium | libs/core/src/trace/trace.ts:140-174 | No source-map/transpiled-frame handling: only `file://`, `?#`, `webpack://` stripped; no `.js`→`.ts/.tsx` sibling candidates; bundled `dist/*` traces never resolve | Header claims browser/Playwright trace support, but those run bundled code — matches silently vanish | Add sibling-extension candidates, skip dist/build artifacts, or resolve via sourcemap |
| low | libs/core/src/observability/redaction.ts:38-46 | Object branch serializes Date/Error/class instances to `{}` — `obs.error(..., { meta: { error: err } })` logs an empty object; message+stack never appear (nor get redacted) | The most useful debug payload silently disappears | Special-case Date (toISOString) and Error (message+stack via redactString) |
| low | libs/core/src/observability/logger.ts:112-127 | `obs.info("x", { level: "error" })` emits error — `...fields` spread overrides helper level; `duration`'s computed durationMs likewise overridable | Helper name lies about emitted level | Destructure and drop `level`/`durationMs` from the spread |
| low | libs/core/src/context/builder.ts:184, 218 (also :96) | `new CodeGraphDB()` sits outside the try/catch whose catch-path closes the db — constructor throw (locked/corrupt DB) crashes the whole build | `raiken context` crashes instead of omitting a section, defeating documented graceful degradation | Move construction inside the try |
| low | libs/core/src/context/builder.ts:9 via database/connection.ts:28-31, trace/trace.ts:216 | "Read-only" claim is false in practice: every `new CodeGraphDB()` materializes `.raiken/` + an empty DB on fresh projects | Filesystem side effects on fresh clones; can race a concurrent health check | Open readonly (`readonly: true, fileMustExist: true`) for read paths |
| low | libs/core/src/trace/trace.ts:172-173 | Root `""` duplicates an existing candidate — every frame stats its first path twice (up to 6 sync stat/realpath calls per frame) | Doubles chatty sync FS work | Drop the `""` root |
| low | libs/core/src/observability/types.ts:41-51 | `HealthCheckStatus` union is dead — `HealthChecks` re-declares values inline; nothing references it | Drift risk | Use it in HealthChecks or delete |
| note | libs/core/src/observability/context.ts:25, 81 | `getCorrelationContext` has no production caller; `buildOperationCorrelationContext` used only internally | Wider public API than needed | Un-export or document |
| note | libs/core/src/observability/redaction.ts:7 vs 10-11 | Vendor `sk-or-v1`/`sk-ant` patterns shadowed by generic pattern; `SECRET_KEY_PATTERN` misses `storageState`-shaped keys | Redundant patterns; key gap matters for an auth-state tool | Fold patterns; add storage[-_]?state/passphrase |
| note | libs/core/src/observability/health.ts:52-61 | pid-recycled stale operation.json can report false "busy" | Rare | Compare startedAt vs pid start time |
| note | libs/core/src/context/builder.ts:246-258 | "Untested source files (top N)" are first maxRows in DB order, not ranked | Cosmetic | Sort by heuristic or drop "top" |

Clean: log-stream resource leaks — none (no file sinks; all better-sqlite3 handles closed in `finally`). CLI contract (`apps/cli/src/commands/trace.ts`, `context.ts`) matches core: minConfidence clamped, limit validated, `--no-impact` mapping, exit codes.

## Strengths
- Redaction-by-default in the logger: every message/meta passes through redactString/redactValue (key-pattern + value-pattern layers, depth/array caps).
- ALS-based correlation context: per-scope isolation, detached ops merge caller context, privacy-safe projectRef (basename+hash) keeps absolute paths out of logs.
- Strong DB hygiene: per-call open/close in `finally` across graph-query and health probes.
- Trace parser tolerant and multi-format with per-pattern comments; match aggregation deterministic and explainable.
- ctx builder degrades per-section and reports which sections were emitted.

## Test-coverage observations
- `queryTrace`/`resolveFrame` — the resolution+matching half of `raiken trace` — have ZERO tests (trace.spec covers only parseTrace happy paths). Windows paths, symlink canonicalization, monorepo subroots, frame dedup, minConfidence/limit all uncovered.
- context/builder.ts has NO spec anywhere — markdown escaping, redaction (a "token in errorMessage" test would have caught the high finding), maxRows caps, section fallbacks untested.
- logger.spec never asserts out-of-scope events get a correlationId (would fail today).
- redaction.spec lacks Date/Error instance and storageState-key cases.
- health.spec never asserts probeAuth expired/malformed/empty mappings or probeAi degraded branches.

## Verdict
**needs fixes** — unredacted error/test-name text flowing into raiken.ctx.md (built for sharing with external AI agents) is a realistic secret-leak plus prompt-injection path, and Windows trace resolution is broken end-to-end; the rest of the module is solid.
