# Core Review — doctor

**Scope:** `libs/core/src/doctor/` (4 files, 1,320 ln: index.ts 28, fixes.ts 273, environment.ts 432, scan.ts 587)
**Method:** direct line-by-line read (agent delegation failed twice; reviewed in-session). Report-first — no changes made.

## Findings

| Severity | Location | Issue | Why it matters | Fix direction |
|---|---|---|---|---|
| high | libs/core/src/doctor/fixes.ts:182 vs doctor/environment.ts:393 | webServer detection is comment-stripped in the scan (`stripConfigComments`) but RAW in the fixer (`/webServer\s*:/.test(loaded.text)`) — `raiken init` comments out webServer when no dev script exists; later `doctor --fix` flags `baseurl-unreachable` (scan sees no webServer) then `applyAddWebServer` REFUSES: "A webServer block already exists (possibly commented out)" | The README's documented cold-start path (`doctor --fix` after init) dead-ends exactly when the fix is needed; fixer and scanner contradict each other | Use `stripConfigComments` in applyAddWebServer's detection; replace/uncomment the commented block instead of bailing |
| medium | libs/core/src/doctor/fixes.ts:102,158,229 | All three fixers write playwright.config with plain `fs.writeFileSync` — not atomic, no backup | Crash mid-write corrupts the user's Playwright config; a lint tool mutating config without backup is one bad regex from data loss | Route through existing `io/writeFileAtomic`; write a one-time `.bak` |
| low | libs/core/src/doctor/fixes.ts:251-256 | Default branch of `applyDoctorFix` returns `fixId: "widen-testmatch"` for unknown rules | Result records claim a fix id that was never attempted | Add a `"none"` fixId or make fixId optional on failure rows |
| low | libs/core/src/doctor/fixes.ts:72-75 | `testMatch: […]` replacement regex stops at the FIRST `]` — a comment or nested bracket inside the array breaks the rewrite | Config with `// e2e/**]` style comment yields mangled output; guarded only by the next===text check for no-change cases, not for wrong-change cases | Bracket-aware replace or AST-ish parse of the array literal |
| low | libs/core/src/doctor/fixes.ts:205 | Inserted webServer command hardcodes `npm run <script>` regardless of the project's package manager | In pnpm/yarn workspaces `npm run` can resolve differently (lifecycle, workspace protocol) | Detect package manager from lockfiles/device files like the rest of the repo does |
| low | libs/core/src/doctor/environment.ts:242-245 | A RELATIVE `PLAYWRIGHT_BROWSERS_PATH` override not starting with "node_modules" is treated as absolute → resolved against process CWD, not projectPath | Browser-presence check can false-fail (or false-pass) depending on where the CLI was launched | path.resolve(projectPath, override) for relative overrides |
| low | libs/core/src/doctor/environment.ts:279 | `if (parsed !== null)` — a config file containing literal `null` parses successfully and skips schema validation entirely | Invalid config silently passes doctor | Use a `parsed !== undefined` sentinel from the try block |
| low | libs/core/src/doctor/scan.ts:295 | `LOGOUT_SIGNAL.test(text)` runs on RAW text — a comment mentioning "logout" suppresses the `auth-state-with-login-flow` error finding | False negative on a real contradiction the rule exists to catch | Strip comments first (stripConfigComments exists) |
| note | libs/core/src/doctor/scan.ts:325 | `inspectAuthState` re-reads the same storage-state file once per scanned spec | O(N) file reads for N specs referencing one state file; trivial cost, easy memo | Cache per stateFile within one scanTests run |
| note | libs/core/src/doctor/scan.ts:541-557 | `collectFiles` silently skips symlinked directories (isDirectory() is false for symlinks) | Monorepo fixtures using symlinks are invisible to doctor | Decide policy: skip-with-note or follow symlinks with cycle guard |
| note | libs/core/src/doctor/fixes.ts:134 | `detectDevServerPort(projectPath, Number.NaN)` — NaN as "no default" sentinel | Readable-but-odd API usage | Optional param instead of NaN sentinel |

## Strengths
- Rule design is thoughtful and documented: conditional `test.skip(condition, reason)` deliberately not flagged; semantic locators excluded from brittle-selector rules; rationale comments cite the FSE 2014 fixed-sleep data.
- `scanAuthPreconditions` is a genuinely smart whole-file analysis (storageState + login-flow contradiction, origin mismatch vs baseURL, expired/empty state) — each with precise, human messages.
- `stripConfigComments` is a proper little state machine (string/template-aware) so commented-out config can't produce phantom findings — the scan side uses it correctly.
- Fixers have post-condition sanity checks (findWebServerRunScripts round-trip) before writing.
- Environment checks are pure fs/schema (no npx side effects), with injectable probe/env/homeDir for tests.

## Test-coverage observations (from spec skim)
- No spec covers the commented-out webServer + `--fix` interaction (the high finding above).
- No spec pins that fixer writes are atomic or leave a backup.
- `scanAuthPreconditions` specs cover the storageState+login contradiction, but not the comment-mentions-logout false-negative path.

## Verdict
**needs fixes** — one high-severity scan/fix contradiction on the documented cold-start path, plus non-atomic config writes; everything else is polish. The scanner itself is excellent.
