# Raiken system review — 2026-09-08

> This is the original audit snapshot. See [the remediation record](system-remediation-2026-09-08.md) for subsequent fixes, verification, and remaining limitations.

## Assessment

Raiken has a substantial, working implementation and a useful architectural split between CLI, dashboard, shared contracts, and core application services. Its existing automated checks exercise real behavior: all 1,947 tests in the four project suites and all 29 browser integration tests passed after preparing the environment. The production CLI builds, its health smoke check passes, and the handwritten golden suite passed 60 executions without retries.

However, the current implementation cannot yet support a strong claim that generated tests and automatic repairs are trustworthy. Targeted probes reproduced false-success and false-green paths that the passing suites do not cover. The most consequential problem is inconsistent enforcement of correctness across generation, standalone repair, graph repair, one-shot outcomes, and evaluation scoring.

This reviews the current working tree, including the user's existing uncommitted changes, against README behavior and implementation contracts. It is a broad system review with deeper tracing of prompts, generation, repair, reporting, API boundaries, and evals—not a claim that every line or every external integration was exhaustively verified. The autonomous-run design document is explicitly **Proposed**; its unimplemented features are not counted as current implementation defects.

Production source was not changed. Review artifacts were added; dependencies, Chromium, and build outputs were prepared to run checks. No live LLM-provider evaluation was performed, so model quality, cost, latency, and resistance to prompt injection remain unmeasured.

## Verification evidence

Checks used Node 22.22.1 and pnpm 10.15.1. The shell initially selected Node 24 and the checkout had no root `node_modules`. Dependencies were installed using the frozen lockfile. Browser/process tests required execution outside the filesystem sandbox. Ambient provider API keys were removed for the final core and integration runs to isolate tests from local credentials.

| Check | Result |
| --- | --- |
| Fresh TypeScript checks, all four projects, Nx cache disabled | Passed |
| Core, Vitest with four workers | 138 files; 1,436 tests passed |
| Shared, Vitest with two workers | 16 files; 70 tests passed |
| CLI, Vitest with two workers | 39 files; 262 tests passed |
| Dashboard, Vitest with two workers | 30 files; 179 tests passed |
| Browser integration suite, serialized | 14 files; 29 tests passed |
| CLI production build, Nx cache disabled | Passed, including dashboard and distribution dependencies |
| Built CLI smoke script | Version 0.6.3 and health endpoint passed |
| Handwritten `auth-flow.spec.ts`, repeated five times with retries disabled | 60 expected passes; 0 skipped, unexpected, or flaky |
| Standard `pnpm lint:boundaries` | Failed: references deleted fixture paths |
| Standard `pnpm check` | Failed before lint: leftover Stryker sandbox contains another root Biome configuration |

The ordinary `pnpm test` invocation also exited at the core Nx target without a useful test failure report. Direct Vitest runs with bounded worker counts subsequently completed all project suites. This audit does not claim that the unchanged `pnpm verify` command is green. Initial core failures from missing Chromium, restricted localhost/process access, and an inherited provider key were eliminated by the environment preparation above.

Logs are under `/tmp/raiken-audit-*.log`. Key final logs: `core-final`, `integration-final`, `typecheck-fresh2`, `build-final`, `golden-final`, `shared`, `cli`, `dashboard`, and `smoke`.

## Standards and implementation boundaries

### S1 — P1: distinct tests collapse into one result

[`playwright-json-report.ts:147`](../libs/core/src/testing/playwright-json-report.ts#L147) assigns the invocation's `testFile` to every spec instead of preserving the reporter's file identity. [`run-outcome.ts:84`](../libs/core/src/testing/run-outcome.ts#L84) then groups by file plus bare test title, omitting the describe path and other distinguishing identity.

**Reproduced:** two different files each containing a failing test named `renders` produce one result row; the second failure is dropped. Identical titles in different describe blocks can also collide. A passing and failing test can consequently look like repetitions of one flaky test.

**Fix:** retain the actual file, full title path, and project identity throughout parsing. Merge only repetitions of the same logical test. Add a reporter regression with duplicate titles across files and describe blocks.

### S2 — P1: indexing APIs can escape the project root

[`indexing.ts:16`](../libs/shared/src/lib/router/indexing.ts#L16) forwards caller-provided paths directly to the application. [`IndexingApplication:48`](../libs/core/src/application/indexing.ts#L48) uses `input.path || this.projectPath` for scanning and database creation. The router's `syncTicket` path uses confinement, but the other indexing procedures generally do not.

**Evidence:** static tracing shows that an absolute sibling path selects another project's code graph/database and can write indexing state there. This bypasses the documented project-scoped path resolver. No real external project was indexed during this audit.

**Fix:** apply the existing project containment resolver at the application boundary consistently, including graph, search, embeddings, and reindex operations. Test sibling absolute paths and symlink paths.

### S3 — P2: report paths permit symlink escapes

[`application/testing.ts:65`](../libs/core/src/application/testing.ts#L65) uses a lexical prefix check for report output. [`report-writer.ts:92`](../libs/core/src/testing/report-writer.ts#L92) uses a similar check for attachments. Interpretation and repair reads contain related patterns.

**Reproduced using temporary fixtures only:** with `project/linked` pointing to a sibling directory, output `linked/reports` wrote outside the project. An attachment pointing through the symlink embedded an outside synthetic text file when its supplied content type was `image/png`.

**Fix:** reuse the existing realpath-aware containment helper for reads and output destinations, including nonexistent destination paths whose ancestors are symlinks.

### S4 — P2: suite totals can label failed suites as passed

[`playwright-json-report.ts:281`](../libs/core/src/testing/playwright-json-report.ts#L281) assigns exactly one failed suite whenever any test fails, then labels the remaining suites passed.

**Reproduced:** two distinct failing suites produced `{ total: 2, failed: 1, passed: 1 }`.

**Fix:** aggregate each suite's own test outcomes before calculating totals.

### S5 — P2: full-suite history uses display labels as filenames

[`test-execution-service.ts:200`](../libs/core/src/testing/test-execution-service.ts#L200) records `target ?? test.suite`. In a whole-suite invocation, the target is absent and the suite can be a breadcrumb such as `a.spec.ts > nested`, which is not a file path.

**Impact:** file history, badges, and source/test associations can miss the outcome records. This follows directly from the parsed data shape and write path.

**Fix:** carry real file identity into the parsed report model and use it in outcome persistence.

### S6 — security boundary to harden: loopback requests bypass Host/Origin checks

[`server-auth.ts:35`](../apps/cli/src/server-auth.ts#L35) authorizes all loopback-mode requests. [`server.ts:104`](../apps/cli/src/server.ts#L104) applies the origin check only in remote mode. A direct authorization probe accepted arbitrary Host/Origin values in loopback mode.

This is a confirmed missing validation boundary, **not a demonstrated browser exploit**. Its exposure depends on browser/network behavior. Given the server's file and test-execution APIs, add local Host validation and an appropriate origin/session policy, then test it at the HTTP boundary.

## Spec and correctness guarantees

### C1 — P1: graph repair accepts changed expectations

The standalone repair command attempts to preserve asserted values, but [`executeRepairAttempt`](../libs/core/src/testing/repair-attempt.ts#L243), used by graph/HITL repair, gates candidates on parsing and selector contradictions without the same preservation check. Its prompt says to make the test pass and to fix assertions/flow. The graph saves accepted candidates at [`repair.ts:84`](../libs/core/src/agent/graph/nodes/repair.ts#L84).

**Reproduced:** given a failure with expected `$59.00` and received `$49.00`, a stub model returned a candidate changing `toHaveText('$59.00')` to `$49.00`. The actual repair implementation accepted it.

**Fix:** make assertion preservation part of one shared repair acceptance policy used by every caller. A passing rerun cannot establish that a changed requirement is correct. Preserve the original failure as an app-bug outcome when no permissible repair exists.

### C2 — P1: the scenario checker accepts expected values in test titles

[`missingScenarioExpectations:193`](../libs/core/src/cover/repair-setup.ts#L193) searches the whole comment-stripped source for tokens. It does not verify that those tokens participate in meaningful assertions.

**Reproduced:** a test titled `cart total is $59.00` with only `expect(true).toBe(true)` yields no missing expectations. The intent checker also reports no uncovered criteria and `vacuous: false`.

This defeats the cover verification check's stated requirement that the draft assert the scenario's expected values. The probe verifies the acceptance helpers, not a complete live-provider cover run.

**Fix:** extract structured assertions tied to observable targets; exclude test names, setup values, and unrelated strings. Verify important cases against a deliberately broken fixture so a passing test must also detect the known defect.

### C3 — P1: the standalone preservation guard also accepts weakening

[`changedAssertedValues:249`](../libs/core/src/cover/repair-setup.ts#L249) compares sets of literal values. It discards polarity, matcher semantics, assertion target, and multiplicity, and only recognizes a limited matcher list.

**Reproduced:** both `toHaveText('$59.00') → not.toHaveText('$59.00')` and `toBe(59) → toBe(49)` return an empty list of changed values.

**Fix:** compare assertion structures, including negation and supported matcher semantics. Handle unsupported forms explicitly rather than interpreting an empty extraction as preserved intent.

### C4 — P1: failed generation can still report one-shot success

[`context.ts:824`](../libs/core/src/agent/graph/nodes/context.ts#L824) converts generation failures into an empty draft plus a prose summary. No draft means no save/approval. [`oneshot.ts:463`](../apps/cli/src/commands/oneshot.ts#L463) therefore sets `producedTest=false`, and [`computeOneShotOutcome:173`](../apps/cli/src/commands/oneshot.ts#L173) only rejects an unexecuted requested run when a test was produced. Its final fallback returns success. Outer agent exceptions are also converted to ordinary result text at [`agent.ts:1050`](../libs/core/src/agent/agent.ts#L1050).

**Reproduced at the actual generation/outcome seams:** a model throwing `429 Too Many Requests` yields `testDraft: ''` and a generation-failed summary; the resulting outcome with save and run requested is `{ ok: true, exitCode: 0 }`.

**Fix:** propagate typed terminal outcomes—completed, failed, blocked, cancelled, busy—and the requested task intent. Legitimate Q&A without an artifact must remain distinguishable from a failed request to generate a test.

### C5 — P2: the flakiness eval counts skipped tests as complete coverage

[`flakiness.ts:86`](../libs/core/src/evals/scenarios/flakiness.ts#L86) counts all result rows against the expected total; line 98 excludes skipped rows from failures.

**Reproduced:** two repeated results containing one passed test and one skipped critical test pass all four scorers with `expectedTests=2`. A nominal 12-test completeness gate could accept a run with 11 skipped tests.

**Fix:** require the expected tests to execute and pass, or define an explicit per-test allowed-skip contract. Compare stable test identities, not only counts and bare names. The real golden suite executed in this audit had zero skips; this finding concerns what its scorer would accept after a regression.

## Prompt and harness assessment

The generation prompt has useful, concrete Playwright instructions: observed selectors and URLs, observable assertions, no fixed sleeps, avoiding `networkidle`, preserving assertion polarity, and keeping credentials in environment variables. Context planning, bounded graph steps, bounded repairs, grounding corrections, durable approvals, and real browser integration coverage are good foundations.

Three areas need work before calling the prompts and harness validated:

1. **The repair objective is inconsistent with the generation objective.** “Fix this failing Playwright test so it passes” plus “fix assertions/flow” permits adapting the test to a broken app. The executable probes above show the acceptance layer also permits this. Revise the objective and enforce it centrally.
2. **Evidence is mixed into privileged instructions.** Source text, DOM summaries, memory, and flattened conversation history are assembled into the same system message (`prompts.ts`, `context.ts:580–618`). There is no explicit untrusted-evidence treatment or prompt-injection evaluation suite in the reviewed paths. Separate the instruction layer from quoted evidence and preserve conversation roles. This is a design risk; model susceptibility was not measured here.
3. **The evals do not measure the full LLM workflow.** Playground and benchmark scenarios exercise discovery, auth, grounding helpers, and browser behavior; the repeated golden suite is handwritten. None of those passing results establish generated-test correctness, repair preserving a known app defect, provider reliability, or prompt-injection resistance. Add representative and adversarial model cases with prompt/model/config identification, repeated trials, artifact scoring, and expected failure behavior.

A smaller implementation issue: generation's best-candidate comparison at `context.ts:751–754` applies the polarity penalty to the new candidate but compares against the previous candidate with the penalty forced to false. Store the complete score/quality state with each candidate so correction selection uses the same criteria on both sides. This was identified statically, not reproduced as a full model run.

`validateTestCode` also accepts a commented-out `test(...)` plus an unrelated valid statement, because parsing is followed by a regex over the original source. Runtime zero-test checks provide another layer, but this structural gate does not itself prove a Playwright test exists. Use the parsed AST for that check.

## Verification tooling findings

- **P2 — stale boundary-lint inputs:** `package.json:15` names `tools/playground` and `tools/playground-auth`, which were replaced. ESLint exits before reporting boundary violations, including in CI. Update the script to existing fixture locations.
- **P2 — mutation output breaks the normal Biome check:** `.stryker-tmp` is gitignored but is not excluded in Biome's file configuration. Its copied root `biome.json` causes a nested-root configuration error. Exclude mutation sandboxes from the tools that scan the repository. This is a current-workspace failure, not evidence that a clean CI checkout has that sandbox.

## Reproduction artifacts

These probes call current implementations and use synthetic inputs; they do not contact an LLM provider:

```sh
node /tmp/raiken-system-audit-probe.cjs /Users/Armand/Documents/Code/raiken-app
node /tmp/raiken-generation-outcome-probe.cjs /Users/Armand/Documents/Code/raiken-app
```

The first demonstrates C1, C2, C3, and C5. The second invokes the real generation node and extracts the actual pure outcome function through TypeScript's AST to demonstrate C4. It tests those seams rather than launching the complete CLI. Reporter/auth/report-attachment proof bundles and synthetic files are under `/var/folders/z6/t4sj1rj52fzc0ljl0y9rj0dm0000gn/T/raiken-review-proof-bW9dD2`.

## Recommended repair sequence

1. Define shared terminal outcomes and one repair/verification acceptance contract. Pin C1–C4 as regressions across CLI, graph, and HITL entry points.
2. Preserve test identity through parsing, repetition merging, reporting, and persistence. Pin S1, S4, and S5 together.
3. Apply the existing containment policy to indexing and report/repair paths. Test actual symlink and sibling-directory behavior.
4. Correct skipped-test scoring and restore the standard lint/check commands.
5. Add model-driven evaluations that run the same generated artifact against a correct and deliberately defective app, plus prompt-injection and failure/cancellation cases.

The rule this review establishes: **whenever a system claims a test or repair is verified, first prove that the same acceptance path rejects a plausible false green.** Passing happy-path fixtures alone did not reveal these gaps.

Standards axis: five concrete implementation findings and one qualified security-boundary concern; the highest priorities are result identity loss and indexing confinement. Spec axis: five findings; assertion preservation and typed failure outcomes are the highest priorities. Two additional verification-tooling defects prevent the unchanged standard checks from being green.
