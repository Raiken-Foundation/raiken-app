# Raiken System Walkthrough Review

> A static, read-only walkthrough of every Raiken subsystem, scored against three
> metrics: **correctness**, **simplicity**, **robustness**. Every finding cites
> `file:line`. This is a diagnosis, not a fix — no code was changed.
>
> Rating scale per metric: **Solid** (works as intended, few rough edges) ·
> **Needs work** (correct in the common case, notable gaps) · **At risk**
> (defects likely to bite in normal use).
>
> Severities: **P0** breaks core UX / data integrity · **P1** frequent wrong
> results or security-relevant · **P2** rough edges / edge cases.
>
> Method: five parallel read-only investigations across the eight subsystems,
> cross-checked, with the highest-impact claims spot-verified against source.

---

## Scorecard at a glance

| # | Subsystem | Correctness | Simplicity | Robustness |
|---|-----------|-------------|------------|------------|
| 1 | Agent memory & persistence | Needs work | Needs work | Solid |
| 2 | Agent graph orchestration & HITL | Solid | Needs work | Solid |
| 3 | Browser session & DOM actions | Needs work | Needs work | Solid |
| 4 | Test generation | Solid | Needs work | Solid |
| 5 | Test execution & editor/diffing | Solid | Needs work | Needs work |
| 6 | Site discovery | Needs work | Solid | Needs work |
| 7 | CLI / server / REPL | Needs work | Needs work | Needs work |
| 8 | Cross-cutting concerns | Needs work | Needs work | Needs work |

Overall the system is in good shape after the recent hardening pass: no confirmed
P0s remain. The dominant themes are (a) a few correctness gaps that produce wrong
results silently, (b) duplication / oversized modules hurting simplicity, and
(c) fail-open error handling that hides partial failures.

---

## 1. Agent memory & persistence

**Files:** [libs/core/src/agent/memory.ts](libs/core/src/agent/memory.ts), [libs/core/src/database/db.ts](libs/core/src/database/db.ts), history in [apps/cli/src/commands/chat.ts](apps/cli/src/commands/chat.ts).

**What it does.** Per-project singleton persisting goal state, last exploration, `auth_login`, `action_path:*`, base URL, and selector successes/failures to SQLite. Chat transcript is a separate layer (`.raiken/chat-history.json`).
- Inputs (writers): every turn via `agent.ts:769-811`; `classify-goal.ts:112-152`; `navigation.ts:198-203,429-440`; `interruptions.ts:123-142`; `clearChatMessages` at `router.ts:1013-1017`.
- Outputs (readers): `buildPromptContext` (`memory.ts:582-606`), classifier/context nodes, `getLastExploration` seeded each run (`agent.ts:864-881`).

**Correctness — Needs work.**
- **P1 — Completed task leaves exploration snapshot alive; next task within 30 min inherits it.** On completion, goal + `paused_reason` are cleared but `last_explore_*` is only overwritten when `pagesVisited.length > 0`, never cleared (`agent.ts:1017-1025`); the next run reloads it (`agent.ts:875-881`) and `classify-goal.ts:204-223` restores it for any non-explain intent. Stale pages re-enter graph state without a continuation decision.
- **P2 — Learning loop is defined but never wired.** `recordTestGenerated` / `recordTestResult` / `getTestOutcome` exist (`memory.ts:533-557`, `db.ts:2015-2057`) but no caller invokes them; `buildPromptContext.recentFailures` stays empty for tool-agent runs.
- **P2 — `clearGoalState` leaves keys as `""`** (`memory.ts:280-291`); cache retains them; `getPreference` vs `getGoalState` treat empty string inconsistently (`memory.ts:181-183` vs `245-267`).

**Simplicity — Needs work.**
- **Two exploration persistence models**, only one used: `setExplorationState`/`consumeExplorationState` (`memory.ts:302-340,433-463`) are dead vs the live `setLastExploration`/`getLastExploration`.
- **`getActionPaths` scans all preferences** on every auth/test prompt build (`memory.ts:373-388` from `context.ts:86-100`); preference namespace (`action_path:*`) is unbounded / never pruned unlike selector+outcome tables (`memory.ts:148-150`).

**Robustness — Solid.**
- WAL + `busy_timeout=5000` + write retry (`db.ts:87-96,762-778`); guarded JSON parses in the memory layer.
- **P2 — chat history write is non-atomic** (`chat.ts:30-36`, `writeFileSync`) — crash mid-write can corrupt `.raiken/chat-history.json`.

---

## 2. Agent graph orchestration & HITL

**Files:** [libs/core/src/agent/agent.ts](libs/core/src/agent/agent.ts), [graph.ts](libs/core/src/agent/graph/graph.ts), [state.ts](libs/core/src/agent/graph/state.ts), [nodes/*](libs/core/src/agent/graph/nodes), [orchestrator/index.ts](libs/core/src/orchestrator/index.ts).

**What it does.** LangGraph state machine: classify → navigate/explore → interruptions → gatherContext → generate/answer → hitlSave/hitlRun → repair → summarize. `runToolAgent` bridges live streaming via a `StreamChannel`, pauses at END with `awaitUserMessage`.

**Correctness — Solid.**
- Recursion cap (`agent.ts:892-895`) with a friendly `GraphRecursionError` message (`agent.ts:1050-1061`); base64 HITL markers (`agent.ts:601-603`); abort wired into graph config + explore loop + auth loop.
- **P2 — Two pause shapes.** Navigation/auth pauses route through the `awaitUser` node (`graph.ts:96,115`), but save/run/repair HITL end directly at `END` (`graph.ts:147-152,166`) and rely entirely on `runToolAgent` post-processing (`agent.ts:921-974`). Works, but the divergence is a latent inconsistency.
- **P2 — Classifier-failure pause loses resume context.** `classify-goal.ts:231-234` sets `shouldPause`/`awaitUser` but does not persist `paused_reason` or exploration.
- **P2 — Unreachable edge label** `"summarize"` in the `gatherContext` conditional (`graph.ts:141`); router never returns it.

**Simplicity — Needs work.**
- **Orchestrator is a thin pass-through** adding only logging (`orchestrator/index.ts:54-115`).
- **Pause-reason handling is spread across three sites** (`agent.ts:865-868,977-979`, `interruptions.ts:139-142`).
- **`context.ts` is ~960 lines** mixing gather, generate, answer, auth formatting, and evidence validation.
- `userClearlyWantsTest` safety net (`graph.ts:26-29,137-138`) duplicates classifier responsibility (intentional belt-and-braces).

**Robustness — Solid.**
- Guarded classifier fallbacks; abort-aware sleeps.
- **P1 — No project-level run lock on the agent path.** `BrowserSession.getInstance(projectPath)` is shared and rapid double-submit on the dashboard SSE (`server.ts:117`) can interleave two graph runs and their preference writes; only per-request abort exists.
- **P2 — CLI SIGINT abort doesn't clear `paused_reason`/exploration** (`chat.ts:218-221`), so a cancelled turn can leave pause metadata for the next turn.

---

## 3. Browser session & DOM actions

**Files:** [libs/core/src/browser/session.ts](libs/core/src/browser/session.ts), [dom-capture.ts](libs/core/src/browser/dom-capture.ts), [libs/core/src/agent/tools.ts](libs/core/src/agent/tools.ts).

**What it does.** Persistent Playwright singleton: navigate, frame-aware capture into `DOMContext`, DOM-grounded selectors; `tools.ts` exposes actions to the LLM with auto-start, post-action re-capture, and selector-memory binding.

**Correctness — Needs work.**
- **P1 — Captured `formFields` are never surfaced in the agent-facing DOM text.** They are collected (`session.ts:960-971,1440-1463`) but `formatDOMContext` renders only `interactiveElements` (`dom-capture.ts:173-238`) — no `FORM FIELDS` section, no `suggestedSelector` from `buildFieldSelector`. This directly undercuts grounded test generation for forms.
- **P1 — Post-action re-capture has no settle wait.** `snapshotAfterAction` calls `captureCurrentPage()` immediately after click/fill (`tools.ts:138-152,1044-1087`), unlike `navigate()` which runs `waitForIdle`/`waitForContent`. SPA/async DOM updates can yield a stale snapshot while the tool reports `success:true`.
- **P2 — Ambiguous selector can still act on the wrong element** — strict-mode fallback prefers first visible, then unconditionally `.first()` (`session.ts:660-672`).
- **P2 — Two headless resolvers.** `resolveHeadless` in `tools.ts:100-107` vs inline env parsing in `session.ts:266-275` (accepted values differ, e.g. `"yes"`). Plus `captureDOM` auto-starts headless `true` (`tools.ts:487`) while other tools use `resolveHeadless(false)` — same flow can differ by first tool used.
- **P2 — `discoverLinks()` is main-frame only** (`session.ts:1040-1087`) while capture is frame-aware.

**Simplicity — Needs work.**
- `getBoundBrowserSession()` says "use everywhere" (`tools.ts:83-84`) but graph nodes call bare `getInstance` (`navigation.ts:97,140`; `interruptions.ts:78,111`), skipping selector-memory binding.
- Many session methods (`type`, `focus`, `reload`, `goBack`, `waitForNetworkIdle`, `screenshot`) exist without tool wrappers (`session.ts:754-915`); `PageCapture`/`ActionResultData` snapshot shapes are built twice (`tools.ts:60-76,122-131`).

**Robustness — Solid.**
- Concurrent-start guard, navigation recovery, selector-memory isolation.
- **P2 — Fail-open captures hide partial failure.** `snapshotAfterAction` returns empty summary + `changed:false` on capture failure while the tool still reports `success:true` (`tools.ts:150-152`); `waitForContent`/`waitForNetworkIdle` swallow timeouts (`session.ts:1505-1507,903-907`); per-frame extraction errors skipped silently (`session.ts:1267-1268`).

---

## 4. Test generation

**Files:** [context.ts](libs/core/src/agent/graph/nodes/context.ts), [prompts.ts](libs/core/src/agent/prompts.ts), [utils.ts](libs/core/src/utils.ts), [knowledge-loader.ts](libs/core/src/site-discovery/knowledge-loader.ts), [graph/utils.ts](libs/core/src/agent/graph/utils.ts).

**What it does.** `gatherContext` assembles code files + site knowledge + `baseURL`; `createGenerateTestsNode` builds the system prompt with live DOM + auth/action memory, streams the LLM, cleans via `cleanGeneratedTestCode`, and logs ungrounded selectors.

**Correctness — Solid.**
- Grounding rules, auth-flow memory surfacing, real route catalog, generate-time cleanup are all present.
- **P2 — Selector validation is narrow and non-blocking.** `findUngroundedSelectors` only checks `getByRole|TestId|Label|Placeholder` (`context.ts:32-34`), ignores CSS/`getByText`/`page.locator`, and validates against `state.domSummary` only — not the earlier `pageSummaries` it will also render (`context.ts:517-518`). It logs, never blocks (`context.ts:520-524`).
- **P2 — `loadSiteKnowledge` ignores its `_targetUrl`** (`knowledge-loader.ts:40-45`) — always loads all routes (capped 60), not scoped to the target page.
- **P2 — Legacy non-graph `generateTest()` streams raw output without `cleanGeneratedTestCode`** (`agent.ts:476-482`), diverging from the graph path.

**Simplicity — Needs work.**
- **Three separate code-fence strippers**: `cleanGeneratedTestCode` (`utils.ts:83-95`), `extractCodeFromResponse` (`repair.ts:50-53`), classifier fallback (`classify-goal.ts:268-277`).
- Two parallel generation entry points (graph vs legacy `generateTest` in `agent.ts:347-495`) with different cleanup/grounding; dynamic `require("../site-discovery")` inside the prompt template (`prompts.ts:145-146`).

**Robustness — Solid.**
- Consistent fail-open degradation (planner, gather, site load) keeps generation alive.
- **P2 — Fence parser takes the first ``` block** (`utils.ts:83-87`); prose with multiple fences can truncate valid code. No unit tests for `cleanGeneratedTestCode` or `findUngroundedSelectors` (tests exist for `parseSummaryElements` at `graph-utils.spec.ts:186-259`).

---

## 5. Test execution & editor / diffing

**Files:** [router.ts](libs/shared/src/lib/router.ts) (run/save/get/interpret/repair), [runner.ts](libs/core/src/testing/runner.ts), [edit-blocks.ts](libs/core/src/testing/edit-blocks.ts), [interpreter.ts](libs/core/src/testing/interpreter.ts), [testing-view.tsx](apps/dashboard/src/app/testing-view.tsx), [code-editor.tsx](apps/dashboard/src/components/code-editor.tsx).

**What it does.** Runs Playwright (save-on-run for real paths, temp spec for scratch), parses the JSON report, and drives the editor: tab merge, dirty-buffer guard, run-status targeting, AI interpret/repair with a Monaco diff review.

**Correctness — Solid.** The recent hardening is confirmed present: dirty-buffer guard via `savedContentRef` (`testing-view.tsx:479-485,596-598`), path-only tab keying with `graph:${path}` ids (`417-422,1010-1016`), run status via `runningFileIdRef` (`679-693,943`), per-project `activeTestRuns` lock (`router.ts:1832-1841`), temp-spec filtering (`router.ts:1150-1154`), unique-match SEARCH/REPLACE with full-rewrite fallback (`edit-blocks.ts:143-173`, `interpreter.ts:680-683`).
- **P2 — Client ignores the server `busy` response.** `runTests` returns `{busy:true, stdout:""}` when the lock is held (`router.ts:1834-1841`); the client `onSuccess` always clears the spinner and parses empty output (`testing-view.tsx:653-675`) — a rapid second Run shows an empty results panel instead of "already running".
- **P2 — Stale `files` closures** in `handleFileClose` (`919-922`) and both save `onSuccess` handlers (`510,593`) read the render-scoped `files` rather than the functional `setFiles` updater.
- **P2 — Client/server retry semantics diverge**: client uses `results?.[0]` (`testing-view.tsx:59`) while `TestRunner` uses the last attempt (`runner.ts:294-296`); retried tests can show different pass/fail across surfaces.
- **P2 — Tab closed mid-run** leaves `isRunningTests` true until completion (`testing-view.tsx:934`), so the global "Running…" persists though the tab is gone.

**Simplicity — Needs work.**
- **`testing-view.tsx` is a ~1240-line monolith** with 25+ `useState` and 6+ effects.
- **Duplicate Playwright execution paths** — inline in `router.runTests` (`router.ts:1881-1885`) vs `TestRunner` (`runner.ts:114-268`) vs the agent tool; only `extractReporterJson` is shared.
- **Redundant client-side parsing (~170 lines)** with a greedy JSON regex fallback (`testing-view.tsx:167-234`) despite the server being authoritative.

**Robustness — Needs work.**
- **P1 — `getFileContent` has no path-traversal guard** — `path.join(projectPath, filePath)` with no `assertUnderProjectRoot` (`router.ts:1210-1211`), unlike the save procedures (`router.ts:1622-1627`). Verified.
- **P2 — Run error leaves the tab stuck in `"running"`** — `onError` clears the spinner but never reverts the tab status dot (`testing-view.tsx:696-703,946-948`).
- **P2 — In-process lock only** (`activeTestRuns` module-level, `router.ts:126`); the agent's `TestRunner.runTest` bypasses it entirely (`tools.ts:602-603`).

---

## 6. Site discovery

**Files:** [crawler.ts](libs/core/src/site-discovery/crawler.ts), [db.ts](libs/core/src/site-discovery/db.ts), [url-utils.ts](libs/core/src/site-discovery/url-utils.ts), [knowledge-loader.ts](libs/core/src/site-discovery/knowledge-loader.ts), [detectors/*](libs/core/src/site-discovery/detectors), [router.ts](libs/shared/src/lib/router.ts) discovery procedures, [discovery-view.tsx](apps/dashboard/src/app/discovery-view.tsx).

**What it does.** Autonomous Crawlee/Playwright crawl with same-origin link following, blocker detection, SQLite persistence, and a tRPC control plane (start/continue/pause/abort/clear + auto-resume).

**Correctness — Needs work.**
- **P1 — Queue persistence on pause reads the wrong directory.** `persistQueueState` reads `request_queues/default` (`crawler.ts:1583`) while each run opens a unique queue name (`crawler.ts:298-300,397`) with `MemoryStorage({persistStorage:false})` (`crawler.ts:371-374`), so the on-disk queue often never exists; resume falls back to whatever was last written to `queue_json`. Verified.
- **P1 — SPA/JS-only routes are not discovered.** `enqueueLinks` uses `a[href], [role="link"][href]` only (`crawler.ts:1221-1222`); `[role="link"]` without href and `data-href` (extracted at `1284-1292`) are never queued; no click/`pushState` instrumentation.
- **P2 — Query normalization split.** Crawler honors `preserveQueryParams` (`crawler.ts:1394-1397`) but `SiteKnowledgeDB.normalizeUrl` always strips query (`db.ts:810-812`) and the option is not wired through router/shared config, so it cannot be enabled by the UI/CLI today.
- **P2 — Re-visits never refresh snapshot/forms** — only timestamp + count updated (`crawler.ts:1111-1112`).
- **P2 — Residual auth false positives** — `AUTH_ERROR_PHRASES` still matched against full `page.content()` (`detectors/auth.ts:330-334`) and the broad `/auth` path inclusion (`detectors/auth.ts:55`).

**Simplicity — Solid.** Clear module boundaries (detectors / db / query-service / router). Minor: dead `auth-detector.ts` shim, unused `addSkippedUrl`/`getSessionMemory` on the crawler, a stale comment referencing a non-existent `crawl-session-store.ts` (`crawler.ts:368-369`), and a ~400-line `handleRequest`.

**Robustness — Needs work.**
- **P2 — Start-while-paused bypass after restart.** The guard checks only in-memory `runtime.phase` (`router.ts:2349-2358`); after a server restart runtime is `idle` while the DB session is still `paused`, so a new Start creates a second session row without retiring the old one (`crawler.ts:824-836`).
- **P2 — `continueDiscovery` parses `skippedUrlsJson`/`ignoredCategoriesJson` without try/catch** (`router.ts:2482-2510`) — malformed JSON throws out of the mutation (crawler resume paths guard this).
- **P2 — Global Crawlee `Configuration` per run** (`crawler.ts:375`) — concurrent crawls for different projects would share/overwrite the process-global storage client.
- Abort now deletes the job from the store up front (`router.ts:3207-3210`) which narrows but does not fully close the teardown-vs-new-start window (`router.ts:827-841`).

---

## 7. CLI / server / interactive REPL

**Files:** [chat.ts](apps/cli/src/commands/chat.ts), [server.ts](apps/cli/src/server.ts), [bootstrap.ts](apps/cli/src/bootstrap.ts), [commands/*](apps/cli/src/commands), [bin.ts](apps/cli/src/bin.ts).

**What it does.** `bin.ts` routes to the REPL (default) or `raiken start` (Fastify + SSE). The REPL runs agent turns, DOM slash-commands, and parity commands; `bootstrap.ts` sets up graph/context/memory/watcher.

**Correctness — Needs work.**
- REPL hardening confirmed: `runParityCommand` `process.exit` shim (`chat.ts:105-122`), base64 HITL with raw fallback (`chat.ts:54-68`), Playwright preflight hint (`chat.ts:195-197,498-504`), robust `splitAssign`.
- **P2 — Chat-history format mismatch between REPL and dashboard.** REPL writes a bare array (`chat.ts:33`) and only reads top-level arrays (`chat.ts:15-21`); the router writes `{messages:[...]}` (`router.ts:193`). They share `.raiken/chat-history.json`, so a dashboard-shaped file restores empty in the REPL.
- **P2 — Ctrl-C during the HITL save prompt exits the REPL** instead of cancelling the prompt (`currentAbort` already cleared in the turn's `finally`, `chat.ts:302-304`).
- **P2 — `/clear` clears only in-memory history** (`chat.ts:384-387`) — no `saveHistory`, and unlike `clearChatMessages` it does not clear agent memory.
- **P2 — REPL `/discover` and `/doctor` ignore most flags** the standalone commands expose (`chat.ts:399-410`).

**Simplicity — Needs work.** Command wiring is duplicated between `bin.ts` (`171-400`) and the REPL parity switch (`chat.ts:396-443`); AI-config loaders are duplicated in `cover.ts`/`sync.ts` instead of using `resolveAIConfig`.

**Robustness — Needs work.**
- **P2 — `bootstrapProject` swallows all errors** (`bootstrap.ts:141-143`) — the agent may run with empty context silently.
- **P2 — Underlying parity commands still call `process.exit`** directly (`doctor.ts:42`, `ci.ts:86-101`, `trace.ts:37-60`, `cover.ts:30-66`, `discover.ts:246-252`, `auth.ts:104+`); safe only via the REPL shim, and `auth.ts` has its own exit path with no hint helper.
- **P2 — Unvalidated numeric CLI args** (`trace.ts:40-41`, `context.ts:20`) let `NaN` propagate into core.

---

## 8. Cross-cutting concerns

**Files:** [config/schema.ts](libs/core/src/config/schema.ts), [ai-providers.ts](libs/core/src/agent/ai-providers.ts), [project-context.ts](libs/core/src/analysis/project-context.ts), [router.ts](libs/shared/src/lib/router.ts).

**What it does.** Zod config schema + defaults, multi-provider AI resolution, cached code graph with a file watcher, and the ~3400-line tRPC router surface.

**Correctness — Needs work.**
- **P1 — Config "split brain".** `resolveAIConfig` validates via `raikenConfigSchema.safeParse` and drops the whole `ai` section on failure (`ai-providers.ts:432-438`), while `getConfig`/`updateConfig` read and deep-merge raw JSON with no validation (`router.ts:896-925`); `validateConfig` (`schema.ts:246-247`) is never called. Invalid shapes can be saved then silently ignored.
- **P2 — CLI `cover`/`sync` bypass `resolveAIConfig`** (`cover.ts:140-155`, `sync.ts:21-36`), only honoring `OPENROUTER_API_KEY`.
- **P2 — Singleton keying differs.** `AgentMemory` keys on `path.resolve(projectPath)` (`memory.ts:68-72`) while `ProjectContext` keys on the raw string (`project-context.ts:72-79`) — different path forms can create two contexts for one project.
- **P2 — Router procedures fall back to `process.cwd()`** instead of `ctx.projectPath` (`buildCodeGraph:1035`, `getGraphStats:1109`, `reindexFiles:1443`, and others).

**Simplicity — Needs work.** `router.ts` is a ~3400-line monolith mixing discovery runtime, chat store, test runner, AI, and quality tools; `loadDiscoveryConfig` (shared) re-implements defaults parallel to `discoveryConfigSchema`.

**Robustness — Needs work.** Mixed error conventions in the router (`{success:false}` vs `throw` vs `{error:true}`), no central tRPC error formatter; several raw `JSON.parse` with empty catch across bootstrap/cover/sync; Gemini client lacks the explicit request timeout Anthropic/OpenAI have (`ai-providers.ts:778-785`). `runTests` lock + timeout and job-store cleanup are the robust exceptions.

---

## Top risks (ranked)

1. **P1 — Stale exploration snapshot bleeds into the next task** (`agent.ts:1017-1025` + `classify-goal.ts:204-223`). Wrong-context test generation after an unrelated prior run.
2. **P1 — Form fields captured but not shown to the generator** (`dom-capture.ts:173-238` vs `session.ts:960-971`). Undercuts the whole "ground tests in real inputs" goal.
3. **P1 — Discovery queue persistence dir mismatch** (`crawler.ts:1583` vs `298-300,371-374`). Paused large crawls do not resume with full pending URLs.
4. **P1 — SPA/JS-only routes never discovered** (`crawler.ts:1221-1222`). React-Router-style apps yield little beyond the entry page.
5. **P1 — `getFileContent` path traversal** (`router.ts:1210-1211`). Read-any-file relative to the project root.
6. **P1 — Post-action DOM re-capture without settle wait** (`tools.ts:138-152`). Agent reasons on stale DOM after SPA transitions.
7. **P1 — Config split brain** (`ai-providers.ts:432-438` vs `router.ts:896-925`). Saved settings silently ignored.
8. **P1 — No project-level run lock on the agent path** (`server.ts:117` + shared `BrowserSession`). Concurrent runs interleave state.

## Notes
- No confirmed P0 defects remain; the prior hardening pass closed the highest-severity issues (streaming, editor clobber, tab keying, run serialization, base64 HITL, recursion cap, auth-route mapping, blocker dedup).
- Recurring simplicity debt: `router.ts`, `testing-view.tsx`, and `context.ts` are oversized; test-result parsing and code-fence stripping are duplicated 2-3 times each.
- Recurring robustness pattern: deliberate fail-open (capture, waits, planner, site load) keeps flows alive but hides partial failure from both the agent and the user.
