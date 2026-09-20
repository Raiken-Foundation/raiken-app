# Core Review — evals

**Scope:** `libs/core/src/evals/` (10 files, ~1,477 lines — `raiken eval` harness: playground | benchmark | flakiness)
**Method:** delegated line-by-line review (all files read fully; specs skimmed; cross-module contracts verified: RunOutcomeStatus literals, SiteDiscovery statuses, BrowserSession, SiteKnowledgeDB, CLI exit mapping). Report-first — no changes made.

## Findings

| Severity | Location | Issue | Why it matters | Fix direction |
|---|---|---|---|---|
| high | libs/core/src/evals/scenarios/benchmark.ts:447-449 (scorer at 487-491) | Golden-suite gate passes VACUOUSLY when the golden file is missing: existsSync ? validateSelectorGrounding(...) : null → goldenContradictions ?? [] → the no-false-contradictions score passes having validated nothing | A rename/move of tools/playground-tasks/tests/auth-flow.spec.ts silently disables the false-positive gate while the eval stays green — exactly the false-confidence failure mode this harness exists to prevent | Missing golden file = failed score (or explicit skip with reason), never a pass |
| medium | libs/core/src/evals/runner.ts:47-49 (contradicts types.ts:47-52) | Any skipped scenario fails the whole run (reports.every(r => r.skipped === undefined && r.passRate === 1)) while types.ts documents the opposite contract ("skip cleanly instead of failing") | One missing env var among N passing scenarios → entire eval FAIL (exit 1) with zero regressions; report shows FAIL with only skip lines. Latent today but it's the documented purpose of requiresEnv; the all-skipped case is spec-pinned, the mixed case is not | Exclude skips from every() and report them separately (or fix the doc); pin the mixed case |
| medium | libs/core/src/evals/scenarios/benchmark.ts:320 (data 299-307) | "resume-discovers-pages" (≥1) scores the CUMULATIVE page table (getAllPages over the shared workDir DB includes first-pass rows); first-pass URLs never captured so a delta is impossible | If the fixture's unauthenticated pass ever records ≥1 content page, the gate becomes vacuous — a resumed crawl discovering nothing new still passes | Capture first-pass URLs; require resumed − first ≥ 1 |
| medium | libs/core/src/evals/scenarios/flakiness.ts:34-38, runner.ts:29-30, apps/cli eval.ts:89-97, 120-124 | No upper bound on run counts: runs only integer ≥2, repeat only ≥1, CLI adds no cap — --runs 5000 --repeat 20 multiplies into 100k sequential Playwright executions | Unbounded wall-clock with no elapsed-time circuit breaker; one typo burns hours with no graceful stop | Clamp/reject above sane bounds (runs ≤50, repeat ≤25) or add a max-total-duration guard |
| medium | libs/core/src/evals/targets.ts:102-107 (awaited unbounded at runner.ts:140) | staticSpaTarget.stop() waits on bare server.close(): idle keep-alive sockets block up to ~5s on Node 18, and an ACTIVE connection (streaming/SSE the crawler hit) blocks close() forever; runner awaits stop() with no timeout | A single never-ending response hangs the entire eval indefinitely with no diagnostic | closeIdleConnections()/closeAllConnections() around close(); consider a stop() timeout |
| low | libs/core/src/evals/runner.ts:34 | Dead expression: options.filter ?? "" inside the branch where filter is already truthy | Dead code | Hoisted non-null const |
| low | libs/core/src/evals/scenarios/playground.ts:109-121 | Scorer named "login-surfaces-as-blocker-not-page" passes when /login is recorded as EITHER a blocker or a content page — the not-page property is never enforced (lenience documented) | A regression flipping login pages into content pages passes; the report line claims an unchecked property | Rename or assert the blocker channel |
| low | libs/core/src/evals/targets.ts:68 | new URL(req.url ?? "/", "http://localhost") can throw (OPTIONS * → "*"; raw-host CONNECT) — synchronous throw in the handler = uncaughtException killing the eval | The static server binds 127.0.0.1; any local process or odd request could crash a run | try/catch → 400 |
| low | libs/core/src/evals/scenarios/flakiness.ts:100-110 | "suite-green" fails on ANY non-passed status — a legitimate test.skip() fails the flakiness eval despite being stable | Undocumented strictness; false failures on real project suites | Exclude skipped (or make it an option) and document |
| low | libs/core/src/evals/scenarios/benchmark.ts:429 (+ session.ts:132) | Eval uses BrowserSession.__create (the @internal registry escape hatch) in production code; also passes headless twice (429 + 433) | Fragile coupling to a private seam the dunder name says not to call | Public factory/options-only entry point for evals |
| low | libs/core/src/evals/runner.ts:104 | scenario.id interpolated into the mkdtemp prefix; an id containing "/" makes mkdtempSync throw ENOENT mid-attempt | Developer-controlled but unvalidated footgun | Sanitize the id |
| note | runner.ts:27,44,103,154; targets.ts:161-178 | All timing uses wall-clock Date.now() instead of a monotonic clock | NTP steps can distort durations/deadlines — the only nondeterminism left in an otherwise disciplined harness | performance.now() for intervals |
| note | libs/core/src/evals/report.ts:45-49 (+ eval.ts:145) | A run failing only due to skips (or a filter matching nothing) prints FAIL with zero failure lines and no explanation | Confusing UX for the two nothing-actually-failed outcomes | Render skips/no-match explicitly |

Clean categories: scorer exception handling (fails closed, siblings still run); aggregation math (no empty-set division); per-attempt state isolation (fresh mkdtemp workDir, all DBs/targets/sessions bound to it, cleanup in finally); path traversal in staticSpaTarget (tested); exports.

## Strengths
- Per-attempt sandboxing genuinely tight: fresh workDir per attempt, every resource bound to it, teardown swallowed so it can't mask the attempt result.
- Scorer errors become failing scores instead of aborting; passed requires scores.length > 0 — zero-scorer misconfiguration fails closed.
- Determinism discipline: fixture session minted directly (no login drive), OS-assigned ports, retries:0 ("measure the test, not the retry"), EXECUTED_STATUSES guard.
- The expectedTests suite-size gate is a sharp idea — stability alone can't detect silently-stopped collection.
- Fail-fast fixture validation and traversal-safe static serving, both pinned by tests.

## Test-coverage observations
- report.ts has zero specs (aggregation, skip/error rendering, verdict line).
- commandTarget entirely untested ({port} substitution, exit-before-ready, SIGTERM→SIGKILL escalation).
- Flakiness scorers: only runs-the-whole-suite is unit-tested; every-run-executed-tests, stable-across-runs (divergence, duplicate names), suite-green untested.
- runner.spec doesn't pin mixed skipped+passing → passed (the contract question), keepWorkDirs, throwing stop(), filter-no-match.
- Integration specs skip silently when fixtures aren't built — CI without built fixtures exercises none of the browser gates yet still passes.
- No CLI-level eval option-parsing specs (parsePositiveInt floors 2.9→2; runs×repeat unbounded).

## Verdict
**minor fixes needed** — the harness's core loop (isolation, teardown, fail-closed scoring, aggregation) is solid, but the vacuous golden-suite pass is a live false-confidence hole in a quality gate, and the skip-fails-suite contract, unbounded run knobs, and unbounded stop() wait need tightening before this gates the agent's own accuracy claims.
