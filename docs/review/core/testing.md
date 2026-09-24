# Core Review — testing

**Scope:** `libs/core/src/testing/` (28 files, ~5,527 lines) — split a–m / n–z
**Method:** hybrid — a–m half (assertion-contract, edit-blocks, index, interpreter; ~1,540 ln) reviewed directly in-session after two agent failures; n–z half (24 files, ~3,985 ln) delegated line-by-line review. Report-first — no changes made.

## Findings

### n–z half (delegated)

| Severity | Location | Issue | Why it matters | Fix direction |
|---|---|---|---|---|
| high | libs/core/src/testing/runner.ts:107 (with 84-92) | Per-test --timeout reused as the whole-subprocess timeoutMs — browser launch + webServer boot + every test (serial, --workers=1) must fit in timeout+5s | A multi-test spec or a 20-30s webServer boot is killed mid-run and reported as timeout though no test exceeded the limit; the repair loop then chases an artifact | Separate runTimeoutMs (scaled/generous wall clock) from per-test --timeout |
| medium | libs/core/src/testing/test-execution-service.ts:156-161 | Non-scratch inlineContent written to the real spec path with only prepareTestArtifactContent — validateTestCode never runs | Violates the documented "single gate every spec-writing path must clear"; the dashboard run path can overwrite a working spec with non-parsing code or leaked markup | Run validateTestCode(cleaned) before the write (scratch exempt) |
| medium | libs/core/src/testing/save-test-artifact.ts:63-69 | The "single save pipeline" never enforces validateTestCode itself; validation lives only at LLM-extraction sites | Gate-by-convention: any new saveTestArtifact caller (e.g. saveGeneratedTest takes arbitrary client content) writes unvalidated code | Enforce the gate inside saveTestArtifact (opt-out only for user-authored buffers) |
| medium | libs/core/src/testing/quarantine.ts:20 | target.endsWith("/"+needle) also fires for directory-qualified needles — quarantining e2e/login.spec.ts silently excludes old/e2e/login.spec.ts | Over-exclusion = silent CI-visible skip of healthy specs; only bare-basename matching is documented intent | Suffix match only when needle has no "/"; exact (normalized, case-insensitive) equality otherwise |
| medium | libs/core/src/testing/playwright-config.ts:159 vs 101-107 | playwrightConfigExists checks 3 filenames while findPlaywrightConfigPath checks 5 (.mts/.cjs missing) | A .mts-only project reports "no config" → generatePlaywrightConfig writes a new .ts which then wins resolution — silently hijacking the user's config | Reuse PLAYWRIGHT_CONFIG_CANDIDATES |
| medium | libs/core/src/testing/port-detector.ts:64-66 | Lazy brace + \\bport: matches nested blocks — server: { hmr: { port: 24678 } } returns the HMR port | Wrong port → generated tests target the wrong URL and fail as "app broken"; hmr.port without server.port is common | Match port only at depth 1; skip hmr/proxy sub-blocks |
| medium | libs/core/src/testing/playwright-json-report.ts:38-70 | extractReporterJson scanner is O(n²): an unmatched { in preceding stdout makes every later { rescan to EOF | CPU stall parsing every run's stdout; amplified by the double parse in test-execution-service.ts:284-293,346-350 | Skip forward after unbalanced scans or bound rescans |
| medium | libs/core/src/testing/test-execution-service.ts:357 | void this.reconcileReviewedWorkflow(...) — fire-and-forget, no catch | A WorkflowStore throw becomes an unhandled rejection → Node default crashes the dashboard server after a test run | try/catch or .catch() |
| low | libs/core/src/testing/test-code-validation.ts:21 | Markup gate blocklist bypassable: `<answer>{test('x',()=>{})}</answer>` parses as JSX with a real test() call | Residual bypass for models wrapping code in arbitrary XML-ish containers | Require test( at statement level, not inside JSX expression containers |
| low | libs/core/src/testing/repair-attempt.ts:87 | Repair takes the FIRST ts fence; generation's cleaner collects all and picks the most test-like | A small illustrative snippet before the real fix makes repair fail where generation succeeds | Reuse the all-fences best-block selection |
| low | libs/core/src/testing/report-parser.ts:59-61 | failed+timedOut+errored → NaN for legacy CI reports missing keys | NaN propagates into summaries and UI | Default each field ?? 0 |
| low | libs/core/src/testing/report-writer.ts:507-510 | Markdown artifact links embed raw path.relative() — spaces/parens/Windows backslashes break links | Broken screenshot/video links in .md reports | URL-encode; normalize \\→/ |
| low | libs/core/src/testing/storage.ts:18-50 (+ runner.ts:54-64,245-247) | Dead code: TestStorage/saveTestToTemp/saveTestToProject/cleanup have no production callers; if revived, no containment/validation and cleanupTemp deletes a shared tmp dir across projects | Misleading surface bypassing the save pipeline | Delete |
| low | libs/core/src/testing/playwright-subprocess-runtime.ts:27 | `isWin ? "npx" : "npx"` — identical branches | Dead conditional | Collapse |
| low | libs/core/src/testing/playwright-subprocess-runtime.ts:42-77 | Two byte-identical spawn-options builders | Will drift | One delegates to the other |
| low | libs/core/src/testing/runner.ts:223-238 | extractSelectorFromError duplicates playwright-json-report.ts:122-137 | Dual maintenance | Export and reuse |
| low | libs/core/src/testing/playwright-config.ts:211,248,284-286 | Regex family: baseURL not scoped to use:; testDir mangles ../tests and absolute paths; webServer lazy-brace misses url after nested env:{} then matches any url: | Drift detection and discover seeds act on wrong values | Scope to blocks; anchor stripping; brace-balance |
| low | libs/core/src/testing/test-watcher.ts:59-64 | ignored() passes any file-stat path; relies entirely on parent pruning — raw events under ignored dirs trigger re-runs | Spurious re-runs when tooling writes into node_modules/.raiken mid-run | Check segments for files too |
| note | process-tree.ts:39; playwright-json-report.ts:352-364; run-outcome.ts:64,67; raiken-temp-specs.ts:56; quarantine.ts:20 (case-sensitivity); save-test-artifact.ts:42,82-95 (.. reject + dedupe TOCTOU); spec-normalize.ts:100 | Assorted: taskkill spawn without error listener; catch-all masks mapper bugs as empty reports; error attribution/duration inconsistencies; temp-sweep cross-process race; case-sensitive quarantine on case-insensitive FS; overly-broad ".." reject | See locations | As noted per row |

Clean: process spawn leaks — none (stdio always consumed, settle-once guard, abort re-check, detached-group + descendant re-signal kill chain); report-file races mitigated by writeFileAtomic + per-ms stamps; record-outcomes, repair-loop-service, type-only modules clean.

### a–m half (direct review)

| Severity | Location | Issue | Why it matters | Fix direction |
|---|---|---|---|---|
| low | libs/core/src/testing/interpreter.ts:288-299, 629-640 | Untrusted error text (page-derived assertion messages) embedded in ``` fences without escaping — a fence inside the text breaks out and injects structure into the prompt | Prompt-injection surface; mitigated by EVIDENCE_POLICY system prompt, same class as the classify-interruption finding | Escape or fence-protect untrusted text blocks |
| low | libs/core/src/testing/interpreter.ts:145-148 | stripAnsi handles only color codes (m-terminated) — cursor/erase sequences survive into prompts | Noise in prompts from progress bars | Broaden the pattern ([0-9;]*[A-Za-z]) |
| note | libs/core/src/testing/interpreter.ts:920 | Edits apply to the FULL testCode while the model saw only the first 6000 chars | SEARCH text beyond the budget mismatches → full-rewrite fallback (graceful but wastes a call) | Mention truncation in the edits-mode prompt |
| note | libs/core/src/testing/assertion-contract.ts:115 | isConstant treats object/array expressions as constant regardless of nested non-constant values | Minor precision loss in meaningful-assertion detection | Recurse into elements/properties |
| note | libs/core/src/testing/edit-blocks.ts:117-122 | stripEditMarkers drops any ======= line when block markers present | Rare false-drop in full-rewrite fallback | Only strip within marker-bounded regions |

## Strengths
- Process-tree termination is genuinely well-engineered: detached POSIX groups, pgrep -P descendant enumeration, descendant PIDs for SIGKILL re-signaling, taskkill /T /F on Windows — specs prove the grandchild-group case.
- Untrusted-input discipline: shell:false adapters against spec-path injection; report-writer validates MIME/base64 before data URIs; prompts mark DOM/failure text as untrusted evidence.
- Flaky is a first-class failure everywhere: never counted as passed (memory ranking), verification runs pin --retries=0, dashboard maps flaky→failed.
- Exit-code/report reconciliation catches out-of-spec failures that would read green; "no parsable JSON" is an error, never a pass; compile errors surface as build-error rows.
- interpreter.ts (a–m): edits-first repair with validateTestCode + changedAssertedValues (weakened-assertion) gates, vision-gated with abort-aware text-only retry, always-coherent fallback chain; assertion-contract's AST signatures include guards/exits/promise-handling awareness.

## Test-coverage observations
- quarantine.ts has ZERO specs despite its doc saying "Pure + exported for unit tests" — the CI-visible filter.
- buildTestRunArgs documented as "pure so CLI flags can be verified" — no spec verifies it; busy short-circuit, mid-run cancel, scratch lifecycle, exitCode-vs-report rule untested.
- report-writer escaping/MIME gating; playwright-config extractors (golden fixtures would catch the .mts drift); port-detector (nested hmr.port fixture); spec-normalize re-rooting; test-watcher debounce — all untested.
- repair-attempt: only one happy-path spec; fence selection, no-progress detection, introduced-contradiction rejection uncovered.
- No spec pins the subprocess-kill-vs-per-test-timeout relationship (the high finding).
- (a–m) fence-escape injection case and ANSI variant stripping untested.

## Verdict
**needs fixes** — one realistic high (whole-run subprocess timeout conflated with per-test timeout kills legitimate runs and misreports them as timeouts) plus six mediums (unvalidated inline spec write, gate-by-convention save pipeline, quarantine suffix over-match, .mts config-overwrite hijack, HMR port misread, O(n²) stdout scanner); the process-management core itself is solid, and the interpretation/repair half (a–m) is close to ship-shape.
