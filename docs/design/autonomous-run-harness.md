# Autonomous Run Harness — Design Document

> **Status:** Proposed
> **Scope:** A single prompt-driven, fully-autonomous testing loop for Raiken — `raiken run "<prompt>"` — that discovers, drafts (grounded), runs, repairs (honestly), checks flakiness, and reports, with a harness that is provably better than hand-written E2E and naive LLM test-gen.

## How to read this document

This is an **implementation-grade** design. Every section names the exact files, functions, types, and reuse points in the existing codebase so an engineer can build it without re-discovering the architecture. Lines of code referenced are against the repo at the time of writing (`develop` branch, v0.6.3).

Before implementing, skim **§3 (What already exists)** — the most important fact in this doc is that **~70% of the autonomous loop is already built**. The work is a thin orchestration seam + a verification oracle + budgets/flakiness/resume, *not* a greenfield agent.

---

## 1. Context & forcing function

Raiken today is invoked as a CLI/REPL: `raiken -p "test the login flow"` (one-shot), the interactive REPL (`raiken`), or the individual commands (`discover`, `cover`, `test`, `repair`, `report`).

The one-shot path already drives a **LangGraph agent** (see §3) through `classify-goal → navigate → explore → gather-context → generate-tests → hitl-save → hitl-run → repair → summarize`. But it is not a *complete, walk-away* harness:

- It runs the generated test **once**. "Passed once" ≠ "works."
- It has no **flakiness** check.
- It has no **wall-clock / LLM-call / browser-run budget** or **resume**.
- Its honesty boundary (`computeOneShotOutcome`) is good but does not yet fold in the **verification oracle** (scenario-expectation coverage) or the **bad-app self-check**.
- There is no single command whose contract is: *"one prompt in, a verdict + report out, fully unattended, with a guarantee it never silently greens a bug."*

The forcing function is the product question: **can a user write one prompt and have the system do everything, with a harness better than traditional methods?** The answer is yes, and this doc specifies how.

## 2. Goals & non-goals

### Goals
1. **One prompt, one command:** `raiken run "<prompt>"` executes the full pipeline to a terminal verdict + report, unattended.
2. **Bounded autonomy:** LLM calls, browser runs, and wall-clock are budgeted; a run can be **checkpointed and resumed**.
3. **Green ≠ correct:** a verification oracle proves the test *asserts what the scenario asked for* and *catches a deliberately-buggy app* — not merely that it passed.
4. **Flakiness-aware convergence:** the final spec is run `N×`; unstable specs are quarantined, not reported as "done."
5. **Never silently green a bug:** the existing assertion-value guard + grounding + unverified markers are *hard stops* the autonomous loop cannot bypass.
6. **Measurably better than traditional:** the harness self-measures via the existing eval suites (`benchmark`, `flakiness`); the verdict reports *why* it is trustworthy.

### Non-goals
- A background daemon that watches the app forever (use `--watch` / git hooks / CI for that — see §16).
- Replacing the REPL or `-p` (the new `run` composes the same graph; it is a stricter, fully-autonomous *caller* of it).
- Multi-app / multi-repo orchestration in v1 (one project per run).
- Cloud hosting (local-first per `docs/FUTURE_IMPLEMENTATIONS.md`).

## 3. What already exists (do not rebuild)

This is the single most important section. Reuse, don't reinvent.

| Capability | Location | What it does |
|---|---|---|
| **Agent graph** | `libs/core/src/agent/graph/graph.ts` | LangGraph `StateGraph` with nodes: `classifyGoal`, `navigate`, `detectInterruption`, `resolveInterruption`, `captureAfterResolve`, `awaitUser`, `explore`, `gatherContext`, `answerQuestions`, `manageDiscovery`, `generateTests`, `hitlSave`, `hitlRun`, `repair`, `summarize`. Routing is conditional on `intent`, `nextTool`, `targetUrl`, `interruption`, `shouldPause`, `shouldRunTests`. |
| **Graph state** | `libs/core/src/agent/graph/state.ts` | `GraphState` (Annotation.Root): `userPrompt`, `intent`, `targetUrl`, `pageSummaries`, `testDraft`, `savedTestPath`, `testRunResult`, `repairAttempts`, `lastRepairedCode`, `shouldPause`, `awaitUserMessage`, `groundingViolations`, `resumeBlocker`, `exploreBudgetMs`, `maxExplorePages`, … |
| **Orchestrator entry** | `libs/core/src/orchestrator/index.ts` | `runOrchestrator(options): AsyncGenerator<string, OrchestratorResult>` — streams text, returns `{ text, hitlActions, toolCalls, workflowId }`. **Per-project busy lock** (`activeAgentRuns` → "busy" message; must map to exit 4). Wraps `beginOperationScope` + `acquireProjectOperation`. |
| **One-shot caller** | `apps/cli/src/commands/oneshot.ts` | `raiken -p`. `OneShotOptions` (`prompt, json, streamJson, save, run, diagnose, headed, timeoutMs, allowUngrounded`). **`computeOneShotOutcome(input)`** is the honesty boundary (pure fn): save-error / awaited-user / uncollected-spec / failed-run → not-ok with exact exit code. |
| **Bounded repair loop** | `libs/core/src/testing/repair-loop-service.ts` | `RepairLoopService.shouldContinueRepair(state, autonomy)`: true iff `autoCorrect !== "off" && repairAttempts < maxRetries`. `nextStatus()` → `completed | repairing | await_repair_review`. |
| **Repair attempt** | `libs/core/src/testing/repair-attempt.ts` | `executeRepairAttempt(deps, input)` → `{ fixedCode?, noProgress?, groundingViolations?, summary }`. Re-grounds against captured DOM + source selectors; rejects fixes that introduce contradictions. |
| **CLI repair (value guard)** | `apps/cli/src/commands/repair.ts` | `repairFailedRun` loop with the **assertion-value guard** (`changedAssertedValues` + `describeWeakenedAssertion`), proven-absent/present selector guards, parent-traversal guard, oscillation detection, `--allow-weaken` opt-out. |
| **Cover (the oracle, partial)** | `apps/cli/src/commands/cover.ts` + `libs/core/src/cover/` | `cover --verify` closes the loop: runs the draft, and **G1** refuses to verify when `missingScenarioExpectations(draft, scenario)` is non-empty ("passes without asserting the scenario's stated expectations = false green"). `assessGeneratedDraft` produces `{ needsReview, blocked, reviewReasons }`. |
| **Honesty helpers** | `libs/core/src/cover/repair-setup.ts` | `scenarioExpectedTokens`, `missingScenarioExpectations`, `changedAssertedValues`, `extractProvenAbsentLocators`, `extractProvenPresentSelectors`, `extractValueMismatch`, `describeAssertionValueMismatch`, `describeTimeoutFocus`, … |
| **Test runner** | `libs/core/src/testing/runner.ts` | `new TestRunner(projectPath).runTest(testFile, { retries })` → `TestRunResult[]` (`{ name, suite, status, duration, error, attachments }`). |
| **Eval harness** | `libs/core/src/evals/runner.ts` | `runEvalScenarios(scenarios, { repeat, filter, keepWorkDirs, log })` → `EvalReport { scenarios, passed }`. `buildFlakinessScenario({ projectPath, testFile, runs, expectedTests })` (in `scenarios/flakiness.ts`) — runs a spec `N×`, scores `every-run-executed-tests`, `stable-across-runs`, `runs-the-whole-suite`, `suite-green`. |
| **Discovery** | `libs/core/src/site-discovery/` + `cover/knowledge-gate.ts` | `runBoundedDiscover`, `ensureSiteKnowledge`, `hasUsableSiteKnowledge`. `cover` auto-discovers when knowledge is empty + seed URL known. |
| **Code graph + embeddings** | `libs/core/src/analysis/code-graph.ts` + `bootstrap.ts` | `bootstrapProject(projectPath, { watch, verbose })` → builds/maintains the SQLite code graph + embeddings. |
| **Project application** | `libs/core/src/application/testing.ts` | `createProjectApplication(projectPath)` → `{ testing: { listTestFiles, runTests, saveFileContent, repairTestResults } }`. The façade the CLI uses. |
| **Autonomy config** | `libs/core/src/config/schema.ts` | `autonomy: { autoSaveTests, autoRunTests, autoCorrect: "suggest"|"apply"|"off", autoLearn: "confirm"|"auto"|"off", maxRetries }`. Defaults: all conservative (`autoSaveTests:false`, `autoCorrect:"suggest"`, `autoLearn:"confirm"`, `maxRetries:2`). |
| **Tracing/observability** | `libs/core/src/run-traces/recorder.ts` + `observability/` | `RunTraceRecorder` (JSONL under `.raiken/traces/` when `RAIKEN_TRACE` set), `beginOperationScope`, `correlationFields`. |
| **Report** | `apps/cli/src/commands/report.ts` | HTML/Markdown/JSON report from a test-run JSON (`--from`) or by running. |

**Conclusion:** the graph, the honesty guards, the bounded repair loop, the eval/flakiness harness, discovery, and the code graph all exist. The gap is a **run-harness module** that composes them into one bounded, resumable, self-verifying loop with a single honest verdict.

## 4. System context (C4 L1)

```
                         ┌─────────────────────────────────────────┐
                         │  Developer / CI                        │
                         │  "raiken run 'test the checkout flow'" │
                         └──────────────────┬──────────────────────┘
                                            │ one prompt + flags
                                            ▼
                         ┌─────────────────────────────────────────┐
                         │  Raiken (local, in-repo)                │
                         │  Autonomous Run Harness (NEW, §6)       │
                         │  ─ composes the existing agent graph    │
                         │  ─ adds budget + checkpoint + oracle    │
                         │  ─ adds flakiness + final report        │
                         └──────────────────┬──────────────────────┘
            ┌──────────────────────────────┼───────────────────────────┐
            ▼                              ▼                            ▼
   ┌─────────────────┐         ┌──────────────────────┐      ┌────────────────────┐
   │ Running app     │◄────────│ Playwright/Chromium  │      │ AI provider (BYO)  │
   │ (dev server or  │  drive  │ (headless/headed)    │      │ OpenRouter/DeepSeek│
   │  webServer cfg) │         │ real browser          │      │ /Ollama/…          │
   └─────────────────┘         └──────────────────────┘      └────────────────────┘
            ▲
            │ reads/writes
   ┌─────────────────┐
   │ .raiken/raiken.db│  code graph, embeddings, memory, sessions, traces
   └─────────────────┘
```

**Trust boundaries:** the AI provider is the only untrusted external dependency (its output is *never* trusted unverified — see §10). The browser drives the developer's own app. Everything else is local.

## 5. Container view (L2) — what's new

No new deployable. The harness is:

1. **A core module** (new): `libs/core/src/run/harness.ts` — `runAutonomous(options): Promise<RunVerdict>`. Pure orchestration; no CLI/I/O. This is the **deep module** (§8) — the seam.
2. **A CLI command** (new): `apps/cli/src/commands/run.ts` — `raiken run "<prompt>"`. Thin: parses flags, wires `runAutonomous`, prints/streams the verdict, maps to exit codes.
3. **A wiring point** (new): register `run` in `apps/cli/src/bin.ts` alongside `cover`/`repair`/`test`.
4. **A verdict + report contract** (new): the JSON shape returned to callers and written to disk (§13).

Everything else (graph, orchestrator, repair loop, eval harness, runner, discovery, report) is **reused as-is**.

## 6. Component view (L3) — the autonomous loop

### 6.1 The loop, mapped to existing code

```
raiken run "<prompt>"
   │
   ▼
[1] bootstrap + acquireProjectOperation (busy → exit 4)        reuse: bootstrap.ts, operations/
   │
   ▼
[2] ensureSiteKnowledge (discover if empty + seed known)        reuse: cover/knowledge-gate.ts
   │   (or honor --no-discover / --allow-ungrounded)
   ▼
[3] runOrchestrator({ userPrompt, autonomyOverride: FULL, ... }) reuse: orchestrator/index.ts
   │   drives the EXISTING graph: classify→navigate→explore→
   │   gatherContext→generateTests→hitlSave→hitlRun→repair→summarize
   │   • autonomyOverride forces autoSaveTests+autoRunTests+autoCorrect="apply"
   │     (the run command is the explicit consent for unattended writes)
   │   • HITL pauses (auth walls) → if unattended & no session: record a
   │     "needs input" blocker and stop (exit 3), never silently abandon
   ▼
[4] savedTestPath known? ── no ──► verdict: produced-no-test (exit 1)
   │ yes
   ▼
[5] ORACLE (NEW, §10): verify the draft asserts the scenario
   │   missingScenarioExpectations(draft, prompt) must be empty;
   │   else verdict: false-green-risk (exit 1) — do NOT run.
   ▼
[6] TestRunner.runTest(savedTestPath, { retries: 0 })            reuse: testing/runner.ts
   │   (retries:0 — flakiness is measured separately, not papered over)
   ▼
[7] if failed → repair loop (existing graph node + §9 guard)
   │   bounded by maxRetries; stops on no-progress / value-guard trip
   ▼
[8] if green (or repair-exhausted) → FLAKINESS (NEW, §11)
   │   buildFlakinessScenario({ runs: N }).run() → stable?
   │   unstable → quarantine + verdict: flaky (exit 1)
   ▼
[9] BAD-APP SELF-CHECK (NEW, §10.3): re-assert a scenario value
   │   against the live page; if app renders something else, the test
   │   MUST fail (else the harness is broken, not the app).
   ▼
[10] report (reuse: report.ts) + RunVerdict (§13)
   │
   ▼
done — exit code from verdict
```

### 6.2 What is genuinely new vs reused

| Step | New or reuse | Notes |
|---|---|---|
| 1 bootstrap + lock | reuse | wrap in `runAutonomous`; map busy → exit 4 |
| 2 discovery gate | reuse | `ensureSiteKnowledge`; add `--no-discover` escape |
| 3 agent graph | reuse | `runOrchestrator` with `autonomyOverride` = full |
| 4 artifact exists | reuse | mirrors `computeOneShotOutcome` |
| 5 oracle | **NEW** | pure fn `verifyScenarioCoverage(draft, prompt)` |
| 6 run | reuse | `TestRunner.runTest(..., { retries: 0 })` |
| 7 repair | reuse | the graph's repair node + CLI guard already enforces honesty |
| 8 flakiness | **NEW wiring** | call `buildFlakinessScenario` on the saved spec |
| 9 bad-app self-check | **NEW** | optional, see §10.3 |
| 10 report + verdict | **NEW contract** | `RunVerdict` shape; report reuses `report.ts` |

Only steps **5, 8, 9, 10** (and the harness module + CLI command) are new. Everything else is composition.

## 7. Why this is "better than traditional methods"

Traditional = (a) hand-written E2E (correct, brittle, stale) or (b) naive LLM test-gen (fast, ungrounded, silently greens). The harness is better because every failure mode of (b) is a **hard, measurable gate**:

| Naive LLM test-gen failure | Harness gate (existing mechanism) |
|---|---|
| Hallucinated selector | grounding: draft rejected if locator contradicts crawled DOM/source (`validateSelectorGrounding`, `groundingViolations`) |
| Invented assertion value | `@raiken-unverified` + "value asserted but not seen in captured pages" (`assessGeneratedDraft`) |
| Greens by weakening the assertion | **assertion-value guard** (`changedAssertedValues`) — `--allow-weaken` is the only opt-out, and `run` never passes it |
| "Passed once" fluke | **flakiness gate** (`buildFlakinessScenario`, `N×`) — §11 |
| Passes but never asserts the ask | **oracle** (`missingScenarioExpectations`) — §10 |
| Adapts to an app bug | **bad-app self-check** — §10.3 (the test must fail on a known-buggy value) |
| No quality evidence | **self-measured**: the verdict cites the gates that fired; `eval benchmark`/`flakiness` are the standing proof |

The harness is not "more autonomous" — it is **autonomous and self-verifying**. That distinction is the entire product pitch.

## 8. The deep module: `runAutonomous`

**Interface** (everything a caller must know):

```ts
// libs/core/src/run/harness.ts  (NEW)

import type { OrchestratorResult } from "../orchestrator";

/** The autonomy profile the run command forces. Documented, not magic. */
export const RUN_AUTONOMY = {
  autoSaveTests: true,
  autoRunTests: true,
  autoCorrect: "apply" as const,   // the run command IS the consent to apply
  autoLearn: "auto" as const,     // durable memory writes allowed
  maxRetries: 3,                   // see §9; overridable via --max-retries
} as const;

/** Hard inputs — all bounded, all explicit. */
export interface RunAutonomousOptions {
  /** The one prompt. Required. */
  prompt: string;
  /** Absolute project path. Required. */
  projectPath: string;
  /** Abort signal (client disconnect / Ctrl-C → exit 130). */
  signal?: AbortSignal;

  // ---- budgets (§12) ----
  /** Max wall-clock ms for the whole run. Default 10 min. Hard stop. */
  wallClockMs?: number;
  /** Max LLM invocations across the run. Default 30. */
  llmCallBudget?: number;
  /** Max Playwright test runs (incl. flakiness). Default 1 + N. */
  browserRunBudget?: number;
  /** Flakiness repeat count. Default 3. Must be ≥ 2. */
  flakinessRuns?: number;

  // ---- escape hatches ----
  /** Skip discovery even if knowledge is empty. */
  allowUngrounded?: boolean;
  /** Disable the flakiness gate (CI fast path). */
  noFlakiness?: boolean;
  /** Disable the bad-app self-check (§10.3). */
  noSelfCheck?: boolean;
  /** Override maxRetries. */
  maxRetries?: number;

  // ---- plumbing (DI for tests; prod wires the real ones) ----
  /** Streamed text + tool events for live UI. */
  onEvent?: (e: RunEvent) => void;
}

/** The honest verdict. This is the entire return value — callers build reports from it. */
export interface RunVerdict {
  ok: boolean;
  /** One of the verdict reasons below. Always set when !ok. */
  reason?: RunVerdictReason;
  prompt: string;
  savedTestPath: string | null;
  /** Test-run counts (post-repair). */
  runSummary: { passed: number; failed: number; skipped: number } | null;
  /** The gates that fired, with evidence. This is the "trust me" receipt. */
  gates: GateResult[];
  /** Flakiness report (null if --no-flakiness). */
  flakiness: FlakinessVerdict | null;
  /** Did the harness pause for a human it couldn't reach? */
  awaitedUser: { message: string } | null;
  /** Wall-clock + budget consumed. */
  budget: { wallClockMs: number; llmCalls: number; browserRuns: number };
  /** Orchestrator's final text (the agent's own summary). */
  agentText: string;
}

export type RunVerdictReason =
  | "produced-no-test"
  | "false-green-risk"      // oracle: draft doesn't assert the scenario
  | "run-failed"             // tests failed after repair budget exhausted
  | "flaky"                  // flakiness gate: unstable across N runs
  | "awaited-user"           // HITL pause with no answerer (auth wall, etc.)
  | "budget-exceeded"
  | "self-check-failed"     // bad-app check: a buggy value didn't fail
  | "save-error"
  | "uncollected-spec";

export interface GateResult {
  name: "grounding" | "assertion-preservation" | "scenario-coverage" | "unverified-marker" | "self-check";
  passed: boolean;
  detail: string;  // e.g. "3 selector(s) grounded; 0 contradicted"
}

export interface FlakinessVerdict {
  stable: boolean;
  runs: number;
  perRunCounts: number[];
  divergentSignatures: string[];  // empty when stable
}

export type RunEvent =
  | { type: "phase"; phase: "bootstrap" | "discover" | "agent" | "oracle" | "run" | "repair" | "flakiness" | "report" }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; args: unknown; result: unknown }
  | { type: "gate"; gate: GateResult }
  | { type: "done"; verdict: RunVerdict };

/**
 * Drive the full autonomous loop. Pure orchestration — no console, no process.exit.
 * Returns the verdict; the CLI maps verdict.ok → exit code.
 */
export async function runAutonomous(options: RunAutonomousOptions): Promise<RunVerdict>;
```

**Why this interface is deep:** a caller (CLI, dashboard, CI, tests) learns *one* function and one verdict shape. Inside, it composes ~12 existing modules. The complexity (graph, repair loop, flakiness, oracle, budgets) is all *behind* `runAutonomous`.

**Depth rules for the implementation (codebase-design):**
- `runAutonomous` must be **testable through the interface alone** — inject `runOrchestrator` + `TestRunner` + `runEvalScenarios` via optional deps so unit tests stub them.
- No `process.exit`, no `console.log`, no `chalk` in `harness.ts`. All presentation lives in the CLI command (§13).
- `RunVerdict` is **serializable JSON** — it is also the `--json` output and the persisted run record.

## 9. The bounded repair loop (reuse + harden)

The graph's `repair` node already loops `hitlRun → repair → hitlRun` bounded by `shouldContinueRepair` (`autoCorrect !== "off" && attempts < maxRetries`). The harness **does not reimplement** this — it relies on the graph.

Hardening specific to `run`:
- `autonomyOverride = RUN_AUTONOMY` (`autoCorrect: "apply"`) authorizes the write-back inside the loop (the existing node uses `_repairVerification` gate — see `nodes/repair.ts`).
- The **assertion-value guard** (`changedAssertedValues`) is a hard stop the loop cannot bypass: if a fix would change `toHaveText("$59.00")`, the loop ends with verdict `false-green-risk` (or `run-failed` if it was a repair attempt), **never** applying the weakening. `run` never sets `allowWeaken`.
- `maxRetries` default 3 (override via `--max-retries`); on `noProgress` the loop already sets `shouldPause` — in unattended `run` that becomes verdict `run-failed` (with the agent's summary), not an indefinite hang.

**Exit semantics after repair:** if still failing → `run-failed` (exit 1) with the failure diff in the report. If green → proceed to flakiness (§11).

## 10. The verification oracle (NEW — the "green ≠ correct" gate)

This is the one genuinely new piece of logic, and it is **pure & deterministic** (no LLM).

### 10.1 Scenario-expectation coverage (reuse G1)
```ts
// inside harness.ts, step 5
import { missingScenarioExpectations } from "../cover/repair-setup";

function verifyScenarioCoverage(draft: string, prompt: string): GateResult {
  const missing = missingScenarioExpectations(draft, prompt);
  return {
    name: "scenario-coverage",
    passed: missing.length === 0,
    detail: missing.length === 0
      ? "draft asserts every token the scenario stated"
      : `draft does NOT assert: ${missing.join(", ")} — a green run would be a false positive`,
  };
}
```
`missingScenarioExpectations` extracts scenario tokens (`scenarioExpectedTokens`: dollar amounts, %, numbers, quoted phrases, "is/named/called X") and checks they appear in the draft's executable code. **If the prompt says "$59.00" and the draft never asserts "$59.00", the harness refuses to run it.** This is the exact gate `cover --verify` uses at generation time (G1) — `run` applies it again post-repair (a repair could have dropped the assertion).

### 10.2 Assertion-preservation audit (reuse)
After repair, audit the final file vs. the original draft:
```ts
import { changedAssertedValues } from "../cover/repair-setup";
// changedAssertedValues(originalDraft, finalCode) must be empty
```
Non-empty → verdict `false-green-risk` (exit 1). The repair node already rejects weakening internally; this is a **belt-and-suspenders audit on the final artifact**, so even a bug in the node can't ship a weakened test.

### 10.3 Bad-app self-check (NEW, optional, default on)
The headline honesty test from the QA protocol, automated:

- If the scenario states a concrete value (e.g. "$59.00") AND the live app renders a *different* value for the same element (`extractValueMismatch` on the failure, or a fresh capture), the harness asserts the test **fails** on that mismatch. If it *passes* despite a known value discrepancy, the harness itself is broken → verdict `self-check-failed` (exit 1, loud).
- Concretely: when `extractValueMismatch(failureText)` is non-null during step 6/7, that mismatch is *recorded as evidence*, not "fixed." The verdict carries `describeAssertionValueMismatch(mismatch)` so the user sees "the test asserts $59.00 but the app renders $49.00 — application-side bug."

This is the test that proves the harness **catches bugs instead of adapting to them**. `--no-self-check` disables it (CI speed), but the default is on.

### 10.4 Grounding gate (reuse)
`validateSelectorGrounding(finalCode, pageSummaries, sourceSelectors)` — final locators must not contradict captured DOM. Non-empty `groundingViolations` → verdict `false-green-risk`. Reuse the existing function; the gate just surfaces it.

## 11. Flakiness-aware convergence (NEW wiring, reuse harness)

After a green single run, run the saved spec `N×` (default 3, `--flakiness-runs`):

```ts
import { buildFlakinessScenario } from "../evals/scenarios/flakiness";
import { runEvalScenarios } from "../evals/runner";

const report = await runEvalScenarios(
  [buildFlakinessScenario({ projectPath, testFile: savedTestPath, runs: flakinessRuns })],
  { log: (m) => onEvent?.({ type: "text", text: m }) },
);
// scores: every-run-executed-tests, stable-across-runs,
//         runs-the-whole-suite, suite-green
```

- `stable-across-runs` false → verdict `flaky` (exit 1). The spec is **quarantined** (written to `raiken.config.json` `quarantine.testFiles` — the existing mechanism) rather than reported "done."
- `runs-the-whole-suite` false (e.g. 12, 12, 11) → verdict `flaky` (a run silently stopped collecting tests).
- `suite-green` false → verdict `run-failed`.
- `retries: 0` throughout — **the harness measures flakiness, never papers over it with retries.**

`--no-flakiness` skips this (fast CI path), but the verdict then explicitly states "flakiness not measured" in its gates.

## 12. Budgets, checkpointing, resume

### 12.1 Budgets
`runAutonomous` enforces three budgets via a shared `AbortController` + counters:
- **wallClockMs** (default 600_000): a timer aborts the orchestrator + browser runs. → verdict `budget-exceeded` (exit 124, GNU timeout convention).
- **llmCallBudget** (default 30): an `onLLMCall` hook increments a counter; over budget → `budget-exceeded`. The orchestrator already accepts `signal`; aborting it cancels the in-flight LLM call (the agent uses `generateText(..., { abortSignal })`).
- **browserRunBudget** (default 1 + flakinessRuns): bounds Playwright invocations.

The budgets are **conservative by default** so a runaway loop can't burn money; `--budget llm=60,wall=1800s` raises them.

### 12.2 Checkpoint & resume
A run is checkpointed to `.raiken/runs/<runId>.json` after each phase (bootstrap/discover/agent/oracle/run/repair/flakiness). The record stores: `runId`, `prompt`, `phase`, `savedTestPath`, `graphStateSnapshot` (the serializable subset of `GraphStateType`), `budget`, `gates`.

Resume:
```
raiken run --resume <runId>        # or --resume latest
```
Reloads the checkpoint, reconstructs `GraphState` from the snapshot, and continues from the recorded phase. This is why `runAutonomous` takes the graph's state as data, not as hidden internals — **the state is already an `Annotation.Root` with plain serializable fields** (`state.ts`), so checkpoint = `JSON.stringify` of a whitelisted subset.

A run that hit `awaitedUser` (auth wall) resumes from `detectInterruption` once the user runs `raiken auth` to save a session — reusing the existing `resumeBlocker` state field and the `routeAfterGoalClassification` `resumeBlocker → detectInterruption` edge. **No new graph code** — just persist + repopulate state.

### 12.3 Idempotency
Re-running `raiken run "<same prompt>"` with an existing saved spec: the harness diffs the new draft against the existing file; if identical, it skips regeneration and goes straight to run+flakiness. (Reuse the existing "unchanged" detection from the repair loop.)

## 13. CLI surface: `raiken run`

```
raiken run "<prompt>" [options]

Run the full autonomous testing loop for a single prompt: discover (if needed),
draft a grounded test, run it, repair on failure (honestly), check flakiness,
and emit a verdict + report. Fully unattended by default.

Options:
  --json                     Emit the RunVerdict as JSON on stdout (default false)
  --stream-json              NDJSON events (phase/text/tool/gate/done) as it runs
  --headed                   Show the browser (default headless)
  --no-discover              Skip discovery even if site knowledge is empty
  --allow-ungrounded         Draft without grounding (intentional scaffolds)
  --no-flakiness             Skip the N× flakiness gate (fast CI path)
  --no-self-check            Skip the bad-app self-check
  --max-retries <n>          Repair attempts (default 3)
  --flakiness-runs <n>       Flakiness repeat count (default 3, min 2)
  --budget <k=v,...>         llm=N,wall=SECONDS,browser=N
  --timeout <ms>             Shorthand for --budget wall=
  --resume <runId|latest>    Resume a checkpointed run
  --output <dir>             Write the report to this dir (default test-reports/run)
  -h, --help
```

### Exit code contract (extends the existing one)
| Code | Meaning | Verdict reason |
|---|---|---|
| 0 | success | — (all gates green, flakiness stable) |
| 1 | runtime/test failure | `produced-no-test`, `false-green-risk`, `run-failed`, `flaky`, `self-check-failed`, `save-error`, `uncollected-spec` |
| 2 | usage | bad flags / missing prompt |
| 3 | config/auth | `awaited-user` (auth wall, no session) |
| 4 | busy | another run in flight for this project |
| 124 | timeout | `budget-exceeded` (wall clock) |
| 130 | cancelled | SIGINT / client disconnect |

### `--json` output shape (the `RunVerdict`, §8)
Clean JSON on stdout only (diagnostics to stderr; reuse `routeDiagnosticsToStderr`). Verifiable by `JSON.parse` — the existing cleanliness invariant (`--json` stdout must be parseable) is inherited.

The CLI command is **≤150 lines**: parse flags, call `runAutonomous`, print verdict (human) or emit JSON, `cliExit` from the verdict. All logic is in the core module so it is unit-testable without a process.

## 14. Failure modes & error handling (per dependency)

| Dependency | Failure | Harness behavior |
|---|---|---|
| AI provider | rate limit / 429 | repair node already surfaces "Rate limited"; harness → `budget-exceeded` or `run-failed` with the message; never retries infinitely |
| AI provider | empty/non-test response | `validateTestCode` (existing) rejects → `produced-no-test` |
| AI provider | hallucinated selector | grounding gate (§10.4) → `false-green-risk` |
| Browser/app | app down / nav fail | graph's `groundingFailed` → falls back to code-only gen; if still no test → `produced-no-test` |
| Browser/app | auth wall | `awaitUser` → verdict `awaited-user` (exit 3) + tell user to run `raiken auth` |
| Playwright | test timeout | repair node's `describeTimeoutFocus` (existing) → bounded repair; if unresolved → `run-failed` |
| Playwright | flaky | flakiness gate (§11) → `flaky` + quarantine |
| SQLite/db | corrupt | `bootstrapProject` already degrades gracefully; harness records warning, continues if possible |
| Concurrency | another run in flight | `activeAgentRuns` busy → exit 4 (reuse) |
| Client | disconnect | `signal.aborted` → exit 130; checkpoint retained for `--resume` |

**Invariant:** no failure path emits exit 0 on an unverified/weakened/flaky result. This is enforced by `computeVerdict` (a pure function modeled on `computeOneShotOutcome`) — unit-tested in isolation.

## 15. Observability

- **Events:** `RunEvent` stream (`--stream-json`) gives editors live phase/tool/gate updates. Reuses the orchestrator's `onToolCall`/`onToolResult` hooks.
- **Traces:** `RunTraceRecorder` (existing) — the harness passes one explicitly (always-on for `run`, not gated on `RAIKEN_TRACE`), writing JSONL under `.raiken/traces/<runId>.jsonl`.
- **Correlation:** `beginOperationScope` + `correlationFields` (existing) tie the run to an op id surfaced in the verdict.
- **Report:** a `report.ts`-generated HTML/Markdown/JSON in `test-reports/run/<runId>/`, embedding the verdict, the gates receipt, the flakiness matrix, and screenshots from any failure.
- **Memory:** on `autoLearn: "auto"`, outcomes (passing selectors, known flaky specs, app-bug findings) are written via the existing `memory` module so the next run is warmer.

## 16. Continuous operation (answering "continuously")

`raiken run` is **one-shot bounded** by design — the safe default. "Continuous" is achieved by composing it, not by making it a daemon:

- **Dev loop:** `raiken test --watch` (existing) re-runs on file change; wrap with a watcher that calls `raiken run "<prompt>"` on app-source changes.
- **Git gate:** `raiken hooks install --type pre-push` (existing) → runs `raiken run` on push (fail-soft).
- **CI:** `raiken run "<prompt>" --json --no-headed --budget wall=600` as a CI step; the verdict's exit code gates the pipeline.
- **Flakiness patrol:** a cron/CI job running `raiken eval flakiness <spec> --runs 5` (existing) on the generated specs, re-running `raiken run --resume` on regressions.

The harness is the **atomic unit**; continuity is orchestration around it. This keeps the blast radius of any single autonomous run bounded.

## 17. Implementation plan (phased, file-by-file)

### Phase 1 — Core harness + oracle (no CLI yet)
1. `libs/core/src/run/harness.ts` (NEW): `runAutonomous`, `RUN_AUTONOMY`, types (`RunVerdict`, `GateResult`, `FlakinessVerdict`, `RunEvent`). Inject `runOrchestrator`/`TestRunner`/`runEvalScenarios` as deps for testability.
2. `libs/core/src/run/verdict.ts` (NEW): `computeVerdict(intermediate): RunVerdict` — pure, modeled on `computeOneShotOutcome`. Unit-tested first.
3. `libs/core/src/run/oracle.ts` (NEW): `verifyScenarioCoverage`, `auditAssertionPreservation`, `badAppSelfCheck` — thin wrappers over `missingScenarioExpectations`/`changedAssertedValues`/`extractValueMismatch` (all existing).
4. `libs/core/src/run/budget.ts` (NEW): `BudgetGuard` — wall-clock timer + LLM-call counter + browser-run counter, all driving one `AbortController`.
5. `libs/core/src/run/checkpoint.ts` (NEW): serialize/resume a whitelisted `GraphState` subset to `.raiken/runs/<runId>.json`.
6. `libs/core/src/run/index.ts` (NEW): barrel export.
7. Wire into `libs/core/src/index.ts` barrel.
8. **Tests:** `libs/core/src/run/__tests__/harness.spec.ts` — drive `runAutonomous` with stubbed orchestrator/runner/eval; assert every verdict reason + every gate + budget trip + resume. `verdict.spec.ts`, `oracle.spec.ts`, `budget.spec.ts`, `checkpoint.spec.ts`.

### Phase 2 — Flakiness + self-check wiring
9. Wire `buildFlakinessScenario` into the harness (§11); add quarantine write on `flaky`.
10. Wire the bad-app self-check (§10.3).
11. **Tests:** golden fixtures — a known-good app (notes) → `ok`; a known-buggy app (store-buggy, the $59/$49 case) → `self-check` records the mismatch and the test fails.

### Phase 3 — CLI command
12. `apps/cli/src/commands/run.ts` (NEW): flag parsing, call `runAutonomous`, human + JSON + stream-json output, exit-code mapping. ≤150 lines.
13. Register in `apps/cli/src/bin.ts` (new subcommand) + `apps/cli/src/help-text.ts`.
14. **Tests:** `apps/cli/src/commands/__tests__/run.spec.ts` — flag parsing, exit codes, JSON cleanliness, busy → 4.

### Phase 4 — Resume + reports
15. `--resume` path (§12.2).
16. Report generation via `report.ts` into `test-reports/run/<runId>/`.
17. **Tests:** resume round-trip; report file presence + content.

### Phase 5 — Docs + eval
18. README CLI reference section for `run`.
19. Add a `benchmark` eval scenario that runs `runAutonomous` against the playground fixtures and asserts the verdict is `ok` for correct apps and `self-check-failed`/`run-failed` for the buggy one — **the harness measures itself**.

**Effort estimate:** Phases 1–3 are the MVP (a working `raiken run`); 4–5 are hardening. The reuse surface is large, so the net-new code is small (the harness + oracle + budget + checkpoint + CLI ≈ 5 small files + tests).

## 18. ADRs (key decisions)

### ADR-001: Reuse the LangGraph agent; do not write a second loop
- **Status:** Proposed
- **Context:** `runOrchestrator` already drives classify→…→repair→summarize with HITL and an autonomy policy.
- **Decision:** `run` is a **caller** of the graph with `autonomyOverride = RUN_AUTONOMY`, not a parallel state machine.
- **Alternatives:** (a) a bespoke `run` loop — rejected: two loops drift, two repair policies, double maintenance; the graph already has the honesty guards wired.
- **Consequences:** the harness inherits all graph behavior (good and bad); graph changes affect `run`. Mitigation: the verdict/oracle/budget layers are independent and unit-tested, so graph regressions surface as verdict reasons, not silent greens.

### ADR-002: Green ≠ correct is enforced by a pure deterministic oracle, not the LLM
- **Status:** Proposed
- **Context:** the model can't be trusted to judge its own correctness.
- **Decision:** the oracle (`missingScenarioExpectations` + `changedAssertedValues` + `extractValueMismatch`) is **deterministic**; the LLM never decides "is this test correct."
- **Alternatives:** (a) ask the LLM to self-critique — rejected: ungrounded, and the failure mode is exactly "it adapts to the bug."
- **Consequences:** the oracle can't catch *semantic* mismatches the scenario didn't name; that's acceptable — the user's prompt is the contract.

### ADR-003: Flakiness is measured with retries=0, never papered over with retries
- **Status:** Proposed
- **Context:** retries hide flakiness; "passed on retry 2" is a flaky test reported green.
- **Decision:** all runs use `retries: 0`; a separate flakiness gate runs `N×` and quarantines unstable specs.
- **Alternatives:** (a) `retries: 2` then declare stable — rejected: hides the exact signal we sell.
- **Consequences:** genuinely flaky-but-correct tests get quarantined, not hidden; the user sees them and fixes the app or the test.

### ADR-004: Full autonomy is opt-in via the `run` command, not a config default
- **Status:** Proposed
- **Context:** flipping `autonomy.autoCorrect: "apply"` globally changes every surface (REPL, `-p`).
- **Decision:** `run` passes `autonomyOverride = RUN_AUTONOMY` for **that run only**; the config defaults stay conservative.
- **Alternatives:** (a) global config flip — rejected: blast radius; the explicit command is the consent boundary.

### ADR-005: Budgets + resume are first-class, not afterthoughts
- **Status:** Proposed
- **Context:** an autonomous loop without budgets is a cost/time bomb.
- **Decision:** three budgets + checkpoint/resume are in v1 (§12).
- **Alternatives:** (a) just a wall-clock timeout — rejected: doesn't bound LLM cost; can't resume a long run.

## 19. Open questions

1. **Scenario-token extraction strength:** `scenarioExpectedTokens` is regex-based. For scenarios without concrete values ("the cart updates when I change quantity"), the oracle needs a semantic complement. v1: require the user to name a concrete value, or skip the scenario-coverage gate with a recorded warning. v2: LLM-assisted expectation extraction, still gated deterministically.
2. **Multi-spec prompts:** "test the whole checkout" may warrant several specs. v1: one prompt → one spec (the graph's current shape). v2: the classifier fans out N scenarios; the harness runs the loop per spec and aggregates.
3. **Quarantine UX:** auto-writing `quarantine.testFiles` mutates the user's config. v1: write to a session-scoped quarantine and *propose* the config edit; don't mutate `raiken.config.json` unattended.
4. **Cost reporting:** surface approximate token spend in the verdict (needs provider usage data; OpenRouter returns it). v1: count LLM calls; v2: token spend.
5. **Self-check generalization:** §10.3 currently keys off `extractValueMismatch`. For non-value bugs (wrong navigation, missing element), the self-check needs the broader grounding/absence signals. v1: value-mismatch only; v2: absence + strict-mode signals.

---

## Appendix A: Reuse map (exact symbols)

```
runAutonomous
 ├─ runOrchestrator            libs/core/src/orchestrator/index.ts
 ├─ createAgentGraph           libs/core/src/agent/graph/graph.ts   (via orchestrator)
 ├─ GraphState                 libs/core/src/agent/graph/state.ts   (for checkpoint)
 ├─ bootstrapProject           apps/cli/src/bootstrap.ts
 ├─ ensureSiteKnowledge        libs/core/src/cover/knowledge-gate.ts
 ├─ TestRunner.runTest         libs/core/src/testing/runner.ts
 ├─ executeRepairAttempt       libs/core/src/testing/repair-attempt.ts   (via graph)
 ├─ RepairLoopService          libs/core/src/testing/repair-loop-service.ts
 ├─ runEvalScenarios           libs/core/src/evals/runner.ts
 ├─ buildFlakinessScenario    libs/core/src/evals/scenarios/flakiness.ts
 ├─ missingScenarioExpectations  libs/core/src/cover/repair-setup.ts   (oracle)
 ├─ scenarioExpectedTokens       libs/core/src/cover/repair-setup.ts   (oracle)
 ├─ changedAssertedValues        libs/core/src/cover/repair-setup.ts   (oracle)
 ├─ extractValueMismatch        libs/core/src/cover/repair-setup.ts   (self-check)
 ├─ describeAssertionValueMismatch libs/core/src/cover/repair-setup.ts
 ├─ validateSelectorGrounding    libs/core/src/agent/grounding.ts     (grounding gate)
 ├─ computeOneShotOutcome        apps/cli/src/commands/oneshot.ts     (model for computeVerdict)
 ├─ RunTraceRecorder             libs/core/src/run-traces/recorder.ts
 ├─ beginOperationScope / obs   libs/core/src/observability/
 ├─ acquireProjectOperation      libs/core/src/operations/             (busy → 4)
 └─ report command               apps/cli/src/commands/report.ts
```

## Appendix B: The one-line pitch

> `raiken run "<prompt>"` — one prompt in, a verdict + report out. It discovers, drafts grounded tests, runs them, repairs honestly, checks flakiness, and **proves it didn't lie to you** — because every way a naive AI test-gen silently greens is a hard, measured gate. That is the harness better than traditional methods.
