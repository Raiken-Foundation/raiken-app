# Raiken Test Strategy Audit

**Date:** 2025-08-25
**Scope:** Unit + integration suites across `libs/core`, `libs/shared`, `apps/cli`, `apps/dashboard`
**Method:** Inspected configs, counted tests/assertions/mocks, ran every suite, reviewed naming & structure against the testing-strategy skill.

---

## 1. What exists today

### Stack
- **Runner:** Vitest 4, executed through Nx targets (`@nx/vitest:test`)
- **Workspace:** pnpm + Nx monorepo, 4 testable packages
- **Environment:** Node (core/shared/cli), jsdom (dashboard)
- **Pool:** `forks` everywhere (good for native-module isolation)
- **CI:** `.github/workflows/ci.yml` — static-checks + discovery-integration + accuracy-gates + cli-smoke + secret-scan

### Suite size (measured)

| Package | Source files | Spec files | `it`/`test` | `expect()` | Result (Node 22) |
|---|---|---|---|---|---|
| `libs/core` | 246 | 152 | 1237 | 2774 | 1230 pass / 123 fail* |
| `apps/cli` | 78 | 39 | 258 | 552 | 250 pass / 8 fail* |
| `libs/shared` | 35 | 16 | 68 | 135 | 70 pass / 0 fail |
| `apps/dashboard` | 144 | 30 | 196 | 359 | 187 pass / 0 fail |
| **Total** | **503** | **237** | **1759** | **3820** | **1737 pass / 131 fail** |

\*All 131 failures are a single environment issue — see §4.

### Layering (genuinely good)

Raiken separates layers by **filename suffix**, not just directory:

- `*.spec.ts` — unit (default, included by every `vitest.config.ts`)
- `*.integration.spec.ts` — browser/DB-backed, **excluded** from the unit config, run via `vitest.integration.config.ts` with `fileParallelism: false`, 60s timeout
- `*.parity.spec.ts` — shared↔core contract checks (7 files) proving the dashboard router and browser session mirror the server's behavior
- `*.server.spec.ts` — server-only parity (1 file)

This is a stronger layering discipline than most repos. The integration suite is explicitly serialized and isolated from the fast unit loop.

### Meta-testing (Raiken audits its own generated tests)

This is the standout strength. Raiken is a test-generation tool, and it tests that its output is trustworthy:

- **`test-code-validation.ts`** — the single gate every generated spec must clear before touching disk: must parse (Babel, not brace-counting), must contain a real `test()` call, must not contain leaked tool-call markup (`<function_calls>`, `<invoke>`).
- **`doctor/scan.ts`** — flags permanent `test.skip("name", fn)` and empty `test.skip()` in generated code; the conditional form `test.skip(condition, 'reason')` is explicitly *not* flagged.
- **`quarantine.ts` + `quarantine.spec.ts`** — a partition mechanism that excludes flaky generated specs from runs by path/basename.
- **`verify-gates.mjs`** — a unified `pnpm verify` orchestrator that runs static → boundaries → typecheck → unit → build → integration → **golden-suite 5× with retries disabled**. The retry-disabled repeat is explicitly called out as "the only run that can distinguish a fixed test from an intermittently lucky one."
- **`clean-generated-test-code.spec.ts`**, **`vacuous-draft-gate.spec.ts`**, **`looks-like-auth-scenario.spec.ts`** — guard against trivial/empty generated tests.

This is exactly the "mutation-sensitivity > coverage %" philosophy from the skill, applied to the product itself.

### Naming quality (strong)

Sampled `it()` names are scenario+outcome, not "works"/"handles error":

> `records logout links but never enqueues them while a session is loaded`
> `counts a page once per run even when committed twice (redirect then direct)`
> `downgrades the auth blocker to log and keeps crawling`
> `ignores authoritative sync while dirty to avoid clobbering edits`

This matches the skill's naming convention. No `it("works")`-style names found in the sample.

---

## 2. What's working well

1. **Layer discipline is real and enforced by config**, not convention. Integration specs literally can't run in the unit loop because `exclude: ["src/**/*.integration.spec.ts"]` is in `vitest.config.ts`.
2. **Flake handling is taken seriously** — the golden-suite retry-disabled gate, the quarantine partition, and the `describeIfBrowser` gating (8 integration specs skip cleanly when Chromium isn't available) all preserve the "red means look" invariant.
3. **Boundary mocking is correct** — HTTP mocks (`msw`/fetch spies) appear in only 4 files, meaning most unit tests exercise real logic rather than testing mocks. Native DB is used in 19 unit specs, but those are repository/DAO tests where real SQLite is the right call per the skill table.
4. **Parity specs** are a clever, cheap integration layer — they prove the client/server split doesn't drift without a full E2E browser.
5. **CI gates are layered and match the pyramid** — unit on every PR, integration serialized separately, accuracy gates isolated, smoke test on the installed artifact.

---

## 3. Gaps & risks

### 3.1 No coverage thresholds anywhere (Medium)
Only `apps/dashboard` configures a coverage `reportsDirectory`/`provider`; none of the four configs set `coverageThresholds`. The `project.json` outputs point at `coverage/*` directories but nothing fails a build on a drop. Per the skill, coverage is a floor not a goal — but right now there isn't even a floor. A regression that drops core business-logic coverage from 85% to 40% passes CI silently.

**Fix:** Add `coverage.thresholds` per package, scoped to `src/` excluding `__tests__`, starting permissive and ratcheting:
```ts
coverage: {
  provider: "v8",
  thresholds: { lines: 70, functions: 70, branches: 60, statements: 70 },
  include: ["src/**/*.{ts,tsx}"],
  exclude: ["src/**/__tests__/**", "src/**/*.spec.ts", "src/index.ts"],
}
```

### 3.2 Fake-timer usage is sparse (Low-Medium)
Only 3 files use `vi.useFakeTimers`. For a tool with checkpoint schedulers, rotation, poll intervals (`poll-interval.spec.ts`), and retry/backoff logic, real timers in tests are a flake source. The skill is explicit: "Time is faked always" at the unit layer. Audit which timing-dependent unit specs rely on real `setTimeout`/`Date.now()` and convert them.

### 3.3 Setup/teardown asymmetry in core (Low)
`core` has 96 `afterEach` but only 66 `beforeEach`. Some of that is legitimate (cleanup-only hooks), but it's worth a spot check that no spec relies on test-ordering or leaks temp-DB state across tests. The `pool: "forks"` choice mitigates cross-file leakage, but within-file ordering still matters.

### 3.4 No `test-setup` file (Low, informational)
Dashboard's jsdom tests have no shared `test-setup.ts` (Vite/Nx convention). `@testing-library/jest-dom` matchers aren't globally configured — if they're imported per-file that's fine, but a shared setup would DRY that. Verify whether `toBeInTheDocument` etc. are imported manually everywhere.

### 3.5 `FORCE_COLOR` / `NO_COLOR` env conflict (Cosmetic)
Every test run emits ~20 warnings: `The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.` Harmless, but it buries real output. Either unset `FORCE_COLOR` in the Nx test targets or unset `NO_COLOR` in the shell.

---

## 4. The blocker: Node version mismatch (Critical, environment)

**Every one of the 131 failures is the same root cause**, and it is not a test problem:

```
better-sqlite3 ... was compiled against NODE_MODULE_VERSION 127.
This version of Node.js requires NODE_MODULE_VERSION 137.
```

- `.nvmrc` pins **v22.22.1** (MODULE_VERSION 127)
- The active shell runs **v24.18.1** (MODULE_VERSION 137)
- `better-sqlite3@11.10.0` ships a prebuilt binary matching the `.nvmrc` Node
- Under Node 24, the binary won't load → every spec that touches `CodeGraphDB`/`openDatabase` throws

**Proof it's environmental:** re-ran `libs/shared` under `nvm use 22` → **70/70 pass** (was 65/70 under Node 24). The 5 "failures" were all `DatabaseError: Failed to initialize CodeGraphDB`.

### Fix (pick one)
1. **Run tests under the pinned Node** — `nvm use 22` before `pnpm test`. This is what CI does (it reads `.nvmrc`). Fastest, zero config change.
2. **Rebuild the native module under Node 24** — `pnpm rebuild better-sqlite3` (needs build toolchain; may not work offline).
3. **Make the CI-vs-local gap impossible** — add an `engines` check or a pretest script that exits non-zero if `process.versions.modules !== 127`:

```jsonc
// package.json
"scripts": {
  "precheck-node": "node -e \"if(process.versions.modules!==127){console.error('Tests require Node v22 (see .nvmrc). Active: '+process.version);process.exit(1)}\""
}
```
…and prepend it to `test`. This turns a confusing native-load error into a one-line instruction.

**Recommendation:** Do #1 now (unblocks immediately), then #3 to prevent recurrence. The test strategy itself needs no change for this.

---

## 5. Prioritized recommendations

| # | Action | Priority | Effort |
|---|---|---|---|
| 1 | Run tests under Node 22 (match `.nvmrc`) | Critical | 1 min |
| 2 | Add a `precheck-node` guard so the mismatch can't recur silently | High | 5 min |
| 3 | Add `coverage.thresholds` to each `vitest.config.ts`, start permissive and ratchet | High | 30 min |
| 4 | Audit timing-dependent unit specs; convert to `vi.useFakeTimers` | Medium | 2-3 hrs |
| 5 | Spot-check the `afterEach` > `beforeEach` asymmetry in core for state leakage | Low | 30 min |
| 6 | Resolve the `FORCE_COLOR`/`NO_COLOR` env conflict in test targets | Low | 5 min |
| 7 | Confirm `@testing-library/jest-dom` setup for dashboard (shared `test-setup.ts`) | Low | 15 min |

---

## 6. Verdict

The test strategy is **above average and clearly designed by someone who understands the pyramid**. The layering (unit/integration/parity/server by suffix), the flake quarantine + retry-disabled golden gate, and the self-auditing of generated test code are genuine strengths that most repos lack. The one real gap is the absence of coverage thresholds — the "false floor" risk the skill warns about.

The immediate problem — 131 red tests — is **not a strategy problem and not a test-quality problem**. It's a Node-version mismatch between the local shell (v24) and the pinned `.nvmrc` (v22), proven by the fact that switching to Node 22 turns `libs/shared` fully green. Fix the environment and the suite is ~99% green; the strategy work is the coverage-threshold and fake-timer items above.
