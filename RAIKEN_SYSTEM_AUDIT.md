# Raiken System Audit — What Is Wrong

> Purpose: segregate Raiken into its real subsystems and, for **each part**, answer the
> three questions — **What are its inputs? What are its outputs? What does it do?** — then
> verify those answers against the code, walk the edge cases (including "what happens when a
> button is clicked once vs. many times"), and record every defect found.
>
> This is a **diagnosis document**, not a fix. Every finding cites `file:line`. Severities:
> **[P0]** breaks core UX / data integrity · **[P1]** frequent wrong results · **[P2]** rough
> edges / edge cases.
>
> Method: seven parallel code investigations, one per subsystem, cross-checked and merged here.

---

## 0. System map

Raiken is one agent brain reached through two front-ends, over a shared project bootstrap.

```
                 ┌──────────────────────────── user ────────────────────────────┐
                 │                                                                │
        raiken (CLI REPL)                                     raiken start (dashboard)
        apps/cli/commands/chat.ts                             apps/cli/server.ts + React
                 │                                                                │
                 └───────────────┬───────────────────────────────┬──────────────┘
                                 │                                 │
                        runOrchestrator (SSE / in-proc)     tRPC appRouter
                                 │                                 │
                        runToolAgent → LangGraph          runTests / save / discovery
                                 │                                 │
        ┌────────────────────────┴─────────────────────────┐      │
        │  classifyGoal → navigate → detectInterruption →   │      │
        │  resolveInterruption → explore → gatherContext →  │      │
        │  generateTests → hitlSave → hitlRun → repair      │      │
        └───────────────┬───────────────────┬──────────────┘      │
                        │                   │                      │
                 BrowserSession        AgentMemory (SQLite)   SiteKnowledgeDB (SQLite)
                 (Playwright)          + code graph + context      (discovery)
```

The eight parts audited below:

1. Agent memory & persistence
2. Agent graph orchestration & HITL pause/resume
3. Browser session & DOM actions
4. Test generation
5. Test execution & the editor / diffing UI
6. Site discovery
7. CLI / server / interactive REPL
8. Cross-cutting themes

---

## 1. Agent memory & persistence

**What it does.** Persists, across turns and process restarts, what the agent has learned: the
current goal/intent, where the browser has been (last exploration), the real login form, action
paths, the app's base URL, selector successes/failures. Backed by SQLite `preferences` +
`selector_history` (`libs/core/src/agent/memory.ts`). Chat transcript is a **separate**
layer (`.raiken/chat-history.json`, dashboard only).

**Inputs / outputs (verified):**

| Mechanism | Input (writer) | Output (reader) |
| --- | --- | --- |
| Goal state (`active_goal`, `target_*`, `next_tool`) | every turn, `classify-goal.ts:88` | classifier prompt, `classify-goal.ts:66` |
| Last exploration (`last_explore_*`) | on pause + on completion, `agent.ts:838`, `agent.ts:871` | seeded to `pending*` every run, `agent.ts:761` |
| `auth_login` (login url + fields) | on auth blocker detect, `interruptions.ts:107` | `formatAuthFlow`, `context.ts:77` |
| `action_path:*` | when explore finds/performs action, `navigation.ts:415` | logout only, `context.ts:86` |
| `project_base_url` | after successful navigate, `navigation.ts:186` | URL fallback, `navigation.ts:120` |
| `paused_reason` | on pause, `agent.ts:835` | read+cleared at run start, `agent.ts:754` |
| selector history | browser tool success/fail, `tools.ts:86` | prompt hints, `prompts.ts:271` |

### Findings

- **[P0] The agent only ever sees the last 10 chat messages.** `sidebar.tsx:1170` slices
  `conversationHistory` to 10 even though 500 are persisted. This is the single most likely cause
  of "the agent doesn't remember stuff" — anything older than ~5 exchanges is invisible to the LLM.
- **[P1] CLI conversation is RAM-only.** `chat.ts:77` keeps history in a process-local array; on
  exit it is lost. There is no persistence and no reload. (Dashboard persists; CLI does not.)
- **[P1] Stale goal never cleared.** Goal keys are overwritten every turn (`classify-goal.ts:88`)
  but never cleared on successful completion, so `StoredGoal` in the classifier prompt permanently
  reflects the last task and biases classification of the next, unrelated task.
- **[P1] Exploration is auto-restored onto unrelated tasks.** `classify-goal.ts:145` restores
  `last_explore_*` for any non-`explain` follow-up whenever the DB has it — even days later on a
  different feature. Old crawl state leaks into new work.
- **[P1] `currentUrl` is dropped on normal follow-ups.** `classify-goal.ts:151` restores
  `pagesVisited`/`pageSummaries` but not `pendingCurrentUrl` (which was loaded at `agent.ts:765`).
  The agent "remembers where it's been" but not "where it is."
- **[P1] Non-exploration pauses wipe exploration memory.** `agent.ts:838` calls
  `setLastExploration` on *any* pause; a save-approval pause with `pagesVisited: []` overwrites the
  remembered crawl with empty arrays (`memory.ts:321`).
- **[P1] "New command" after a pause doesn't clear the DB.** When the user starts a fresh task
  after an auth pause, `classify-goal.ts:137` clears in-graph pending state but never clears
  `last_explore_*` in SQLite, so the next run reloads and auto-restores it (see above).
- **[P1] "Learn from test runs" is unimplemented.** `recordTestGenerated`, `recordTestResult`,
  `setSelectorStrategy` have **zero callers** outside `memory.ts` — so `recentFailures` and
  `selectorStrategy` in the prompt are always empty.
- **[P2] Clearing chat ≠ clearing agent memory.** `router.ts:999` wipes `chat-history.json` only;
  SQLite goal/exploration/auth memory survives, so the agent still "remembers" after the user
  clears the conversation.
- **[P2] `action_path:*` only read back for logout.** `context.ts:86` hard-codes three logout keys;
  every other persisted action path is dead on later runs.
- **[P2] Singleton keyed by raw path.** `memory.ts:67` keys `getInstance` by the unresolved
  `projectPath` while the DB resolves it (`db.ts:61`); `/proj` vs `/proj/` yields two instances /
  split caches.
- **[P2] One malformed preference disables the whole auth block.** `context.ts:85` `JSON.parse`
  has no per-value guard inside `formatAuthFlow`.
- **[P2] Dead API.** `setExplorationState`/`consumeExplorationState` (`memory.ts:297`) are never
  wired; confusing dual API next to the live `setLastExploration` path.

---

## 2. Agent graph orchestration & HITL

**What it does.** A LangGraph state machine runs one turn: classify intent → (optionally) drive
the browser → gather context → generate a test or answer → optional save/run/repair. Compiled in
`graph.ts`, executed by `runToolAgent` (`agent.ts:771`), wrapped by `runOrchestrator`.

**Inputs / outputs.** Input: `userPrompt`, `conversationHistory`, seeded memory (`pending*`,
`pauseReason`). Output: streamed strings (respond messages, HITL markers, awaitUser prompts, test
draft, summary) + a final `{ text, hitlActions, toolCalls }`.

### Findings

- **[P0] Nothing streams during the run.** `graph.invoke` is fully awaited before the first chunk
  is yielded (`agent.ts:771`); `generateTests` uses `model.invoke`, not streaming (`context.ts:372`).
  The user stares at a frozen UI through the entire navigate→explore→generate cycle, then gets a
  burst. This is the biggest driver of "sometimes it works, feels broken."
- **[P0] Same request → different pipeline.** For `intent=generateTests`, the graph only drives the
  browser when `nextTool=domCapture` **or** `targetUrl` is set (`graph.ts:55`). "Write a test for
  the checkout flow" (no URL, no action) skips the browser entirely and generates **blind** from
  code — even when `project_base_url` is known. "Test the sign-out button" (an action) explores
  live. Identical user intent, wildly different grounding.
- **[P1] Misclassification silently changes outcome.** If the classifier tags a test request as
  `explore`/`explain`, the graph ends in `answerQuestions` (`graph.ts:123`) and the user gets an
  essay instead of a test file. There is no guard/fallback.
- **[P1] `isContinuation` is LLM-judged with no hard guard.** After a pause, whether "my password
  is X" is treated as a credential reply or a brand-new command depends solely on the classifier
  (`classify-goal.ts:119`); a wrong call either drops exploration or misroutes credentials.
- **[P1] Dashboard gets no progress signal.** `onToolCall` is wired in the CLI (`chat.ts:176`) but
  **not** in the server SSE path (`server.ts` omits it), so dashboard users see no "navigating…",
  "clicking…" activity at all.
- **[P1] Overly broad interruption pre-filter.** `utils.ts:425` triggers the interruption LLM on
  any textbox (search bars, filters), so logged-in pages can be misread as auth/consent walls
  during explore.
- **[P2] Two divergent pause paths.** Browser pauses go through the `awaitUser` node/tool; save/run/
  repair pauses jump straight to `END` (`graph.ts:133/142/151`) without the tool — inconsistent
  logging and HITL semantics.
- **[P2] Abort is coarse.** The signal is only checked between nodes (`agent.ts:771`); `explore`
  crawls many pages in one node and `resolveInterruption` sleeps 1800ms (`interruptions.ts:317`),
  neither abort-aware. Stop can take a long time to actually stop.
- **[P2] Dead code.** The `respond` tool is never invoked by any node; `respondMessages` is always
  empty. `detectInterruption`'s `paused_reason` re-read (`interruptions.ts:140`) is dead because
  `agent.ts:757` already cleared it — its intended `saveAuthState`-on-resume never fires here.
- **[P2] No recursion limit configured** — relies on LangGraph's default; combined with the
  resolve→capture→explore cycle this is a latent loop risk (mitigations exist but are implicit).

---

## 3. Browser session & DOM actions

**What it does.** A singleton Playwright session (`libs/core/src/browser/session.ts`) exposes
navigate/click/fill/type/press/select/check/capture, with multi-selector + multi-frame resolution
and a strict-mode retry. Agent tools (`tools.ts`) wrap these for the LLM.

**Inputs / outputs.** Input: a selector (string or ordered array, built at capture time) + values.
Output (to the agent): a small `{ success, message }` — **usually with no DOM snapshot and no URL**.

### Findings

- **[P0] Interactions don't return the new page state.** `clickElement` returns `{clicked:true}`
  (`tools.ts:975`), `fillInput` returns `{filled:true}` (`tools.ts:1008`) — no re-capture, no URL,
  no verification. The agent keeps reasoning against a **stale** `domSummary` until it manually
  re-captures. This is the core reason "actions in the DOM don't work well."
- **[P0] Ambiguous selectors silently act on the wrong element.** On a strict-mode violation the
  session catches it and retries with `.first()` (`session.ts:616`). Combined with generic
  captured selectors like `button[type="submit"]`, `input[type="password"]`, or the fallback
  `"input"` (`session.ts:1568`, `session.ts:93`), a click/fill can hit the wrong control and still
  report `success:true`.
- **[P0] Many interaction tools don't start the browser.** `clickElement`, `fillInput`, `pressKey`,
  `selectOption`, `toggleCheckbox`, `waitForElement`, `saveAuthState` never call `start()`
  (`tools.ts:973+`). Only navigate/capture/discover auto-start. If the LLM clicks before navigating
  → "Browser session not active."
- **[P1] Success is reported without verifying anything changed.** No post-click URL/DOM diff; a
  no-op click, an Enter that didn't submit (`page.keyboard.press` is page-level, not focused —
  `session.ts:712`), or a fill on the wrong field all return success.
- **[P1] `<select>` handled with `fill()`.** Auth field collection includes `role=combobox`
  (`utils.ts:295`); native `<select>` has that role but `fill()` fails on it — auth/interruption
  flows break on dropdowns.
- **[P1] Action timeouts (5s) are shorter than navigation (30s).** Interactions hardcode
  `{timeout:5000}` (`session.ts:505`) while the page default is 30s; slow SPAs make actions fail
  while navigation "succeeds."
- **[P1] The agent only sees 30 of up to 80 captured elements.** `formatDOMContext` truncates to 30
  (`dom-capture.ts:210`); elements 31-80 are invisible, so the LLM invents selectors for them.
- **[P1] Summary parsing drops elements.** `parseSummaryElements` regex (`utils.ts:184`) fails on
  names containing `"` or `:`, and never parses the form-fields block at all.
- **[P2] Fail-open waits.** `waitForContent`/`waitForIdle` swallow timeouts (`session.ts:1442`), so
  navigate returns "success" + snapshot even on a blank SPA shell. `goBack`/`goForward` skip
  `waitForContent` entirely (`session.ts:454`).
- **[P2] iframe / overlay gaps.** `discoverLinks` and `hasBlockingOverlay` are main-frame only
  (`session.ts:977`, `session.ts:1098`); cross-origin frames are silently skipped during capture.
- **[P2] `#id` not escaped in `buildSelectors`** (`session.ts:1563`) unlike `buildFieldSelector`;
  IDs with dots/colons break. The `getByRole('…')` string parser is also fragile (`session.ts:548`).
- **[P2] Missing tools.** `type`, `hover`, `focus`, `reload`, `waitForNetworkIdle` exist on the
  session but have no agent tool — the LLM can't use character-typing for React controlled inputs.
- **[P2] Headless default is inconsistent** across tools (`captureDOM` headless, `navigateTo`
  headed) — mitigated by the new `RAIKEN_HEADLESS` override but confusing.

---

## 4. Test generation

**What it does.** Plans context → gathers code + site knowledge + live DOM → builds a grounded
prompt → one LLM call → cleans → saves. `context.ts`, `prompts.ts`, `agent.ts:84`,
`knowledge-loader.ts`.

**Inputs / outputs.** Input: user prompt, code files, `domSummary`/`pageSummaries`, site routes +
forms, `baseURL`, auth flow, action path, conversation. Output: the system prompt and a `.ts` test
saved under `testDirectory`.

### Findings

- **[P0] Generation frequently runs with no live DOM.** Via the routing bug in §2, the default
  test path is `gatherContext → generateTests` with only code + discovery. The prompt still says
  "use ONLY selectors from [LIVE DOM CONTEXT]" when that block is absent (`prompts.ts:122`) — an
  internal contradiction that leaves the model to invent selectors and routes (e.g. `/login`).
- **[P0] No selector validation on the generation path.** `answerQuestions` validates that emitted
  selectors exist in the DOM (`context.ts:779`); `generateTests` does not — so invalid locators
  ship straight into the test.
- **[P1] Output is only cleaned at save, not on the draft.** `cleanGeneratedTestCode` runs in
  `saveFile` (`tools.ts:476`), but the streamed/opened `testDraft` is raw (`context.ts:383`) — the
  editor can show markdown fences / `SEARCH/REPLACE` markers that differ from disk ("formatting is
  different after save"). If the user runs the unsaved buffer, it can be broken.
- **[P1] `stripEditMarkers` isn't applied on the agent save path** (`tools.ts:476`) — malformed
  `<<<<<<< SEARCH` blocks can be written to disk as invalid TypeScript.
- **[P1] `baseURL` detection misses dynamic configs.** `readPlaywrightBaseURL` regex-scans for a
  literal (`playwright-config.ts:174`); `baseURL: process.env.X` → `null` → the prompt flips to
  "URLs must be absolute," producing wrong `page.goto` targets.
- **[P1] Discovery lists full URLs while the rule demands relative.** `formatSiteKnowledge` emits
  `https://host/path` (`knowledge-loader.ts:164`) but with a `baseURL` set the rule wants relative
  paths (`prompts.ts:85`) — no instruction to strip the origin, so the model emits a rule-violating
  or wrong path.
- **[P1] Live DOM is lost on the second turn.** `domSummary` is not restored from memory
  (`classify-goal.ts:145`), and the `[PAGES EXPLORED]` block requires `>1` page (`context.ts:350`),
  so "now generate the test" after a one-page exploration loses all live grounding.
- **[P1] The generate gate ignores site knowledge.** `context.ts:331` returns a help message when
  there are no code files and no `domSummary`, even if discovery has a full route catalog.
- **[P1] Auth `[AUTH FLOW]` block only appears if `auth_login` memory exists** (`context.ts:95`);
  an auth test without a prior live login interruption still invents `/login`.
- **[P2] Truncation hides critical context** — 15k-token/3k-char-per-file code budget
  (`agent.ts:106`), 3000-char total page summaries (`context.ts:13`), 60-route / 12-field discovery
  caps (`knowledge-loader.ts:18`). The target page/login route can fall off the end.
- **[P2] Save directory mismatch.** Tests save under `raiken.config.json`'s `testDirectory`
  (`hitl.ts:31`), which may differ from Playwright's `testDir` — tests land where Playwright's glob
  doesn't look, and duplicate dirs appear.
- **[P2] Navigation-failure string becomes the "DOM."** `navigation.ts:174` stores
  `"[Navigation failed…]"` as `domSummary`, which is truthy and passes the generate gate — the LLM
  generates from an error message.

---

## 5. Test execution & the editor / diffing UI

**What it does.** `runTests` (`router.ts:1720`) spawns Playwright with the JSON reporter, times out
with SIGTERM/SIGKILL, parses the report. `testing-view.tsx` manages editor tabs, save/run,
analyze/fix, and diff review; a file watcher bumps a counter that refetches `getGraphFiles`.

### Findings — the "clicked once vs many times" lens

- **[P0] Unsaved edits are clobbered on tab switch / window focus.** The `getFileContent` effect
  overwrites the active tab from disk with no dirty check (`testing-view.tsx:451`), and React Query
  is configured `refetchOnWindowFocus: true` (`main.tsx:87`). Switch tabs or click away and back →
  your edits (or an applied AI fix) vanish.
- **[P0] Name-based tab dedup conflates different files.** Multiple paths match tabs by basename
  (`testing-view.tsx:488/749/943`), so `scratch:login.spec.ts` and `tests/e2e/login.spec.ts` are
  treated as the same tab — wrong tab overwritten, content lost. Opening by name even resets a tab's
  content to `""` and triggers a disk load (`testing-view.tsx:984`), wiping a scratch/HITL buffer.
- **[P1] Runs can overlap and the stale one wins.** `handleRunTests` has no run id and no in-flight
  guard beyond the button's `disabled` (`testing-view.tsx:897`); the server has no per-project lock
  (`router.ts:1720`). Two runs → whichever `onSuccess` fires last overwrites results, and analyze/
  fix then work off the wrong run.
- **[P1] Run status is applied to the active tab, not the file that ran.** `onSuccess` uses
  `activeFileId` (`testing-view.tsx:649`); switch tabs mid-run and the wrong tab gets the pass/fail
  badge and counts.
- **[P1] Fix-with-AI can start twice.** `fixInFlightRef` is cleared before `diffReview` is committed
  (`testing-view.tsx:810`), leaving a window where a second Fix starts and clobbers the first diff.
  Analyze has no in-flight guard at all (`testing-view.tsx:690`).
- **[P1] Analyze/Fix read disk, not the editor buffer.** After Apply (unsaved), re-analyze/re-fix
  reads pre-fix on-disk code (`router.ts:2207`) while the UI shows the proposal — wrong baseline,
  mismatched diagnoses.
- **[P1] Scratch-run temp files spawn ghost tabs.** Temp `*.raiken-run-<ts>.spec.ts`
  (`router.ts:1758`) matches the graph test regex, so the watcher indexes it and the merge effect
  opens a ghost tab that then points at a deleted file.
- **[P2] Duplicate tabs from a stale closure.** `saveTestMutation.onSuccess` closes over `files`
  from render (`testing-view.tsx:473`) instead of a functional update — rapid save/chat can create a
  second tab for the same path.
- **[P2] Merge effect reorders tabs** on every refetch (graph files first — `testing-view.tsx:399`);
  the "file closes during run" bug is fixed, but tabs still jump around during a run/save.
- **[P2] `handleFileClose` uses a stale `files` snapshot** to pick the next active tab
  (`testing-view.tsx:873`); rapid closes can leave `activeFileId` on a closed tab (blank editor).
- **[P2] Partial SEARCH/REPLACE match → silent full rewrite.** One failed block triggers a whole-
  file rewrite (`interpreter.ts:668`); `findMatch` also takes the first substring match
  (`edit-blocks.ts:131`), so repetitive specs can be patched in the wrong place.
- **[P2] Diff mode hides all tabs** (`code-editor.tsx:154`) — can't switch files or run while
  reviewing; feels frozen.
- **[P2] `getGraphFiles` capped at 100** (`router.ts:1116`) — in big repos some specs never
  auto-open. Client-side result parsing still uses the fragile greedy JSON regex on the fallback
  path (`testing-view.tsx:167`).

---

## 6. Site discovery

**What it does.** A Crawlee + Playwright BFS crawler (`crawler.ts`) discovers pages/links/forms/
blockers into SQLite; the dashboard (`discovery-view.tsx`) starts/pauses/continues/clears and
resolves blockers; the agent reads the results for grounding.

### Findings

- **[P0] Queue persistence on pause is broken.** `persistQueueState` reads
  `request_queues/default` (`crawler.ts:1580`) but the queue is opened under a unique name with
  in-memory storage (`persistStorage:false`, `crawler.ts:370`), so `queue_json` is usually empty.
  On resume, all pending URLs except the re-seeded start/blocked URL are lost — large crawls can't
  reliably resume. This is the top reliability defect.
- **[P0] SPA routes without `<a href>` are invisible.** Link extraction only follows
  `a[href]`/`[role=link][href]`/`[data-href]` (`crawler.ts:1267`); React-Router `<Link>`/`onClick`
  navigations are never discovered. This is the main "some pages/DOM not discovered."
- **[P1] Query strings collapse distinct pages.** `normalizeUrl` strips all query params
  (`url-utils.ts:9`) and is used for dedup + DB key, so `/product?id=1` and `?id=2` are one page.
- **[P1] Re-visits never refresh the snapshot/forms.** Existing pages only bump visit metadata
  (`crawler.ts:1108`); after auth + `purgeQueueOnResume` the re-crawled start page keeps its
  pre-auth DOM, so post-login content is never captured.
- **[P1] Start is allowed while paused.** `canStart` ignores the paused state
  (`discovery-view.tsx:177`) and `startNewSession` doesn't fail stale paused sessions
  (`crawler.ts:814`) — clicking Start after a pause creates a second session with orphaned blockers.
- **[P1] Auto-resume races manual Continue / handoff.** The poll schedules `startDiscoveryJob` when
  blockers clear (`router.ts:413`) and the handoff success also calls Continue
  (`discovery-view.tsx:273`) — duplicate resume attempts, one throws "already running."
- **[P1] Clear during a running crawl is racy.** `clearDiscoveryData` wipes tables and deletes the
  job (`router.ts:2839`) while the background crawl may still write rows/emit events.
- **[P2] Repeated clicks / lifecycle.** Abort leaves the job in the store until the background
  `finally` runs (`router.ts:3150`) → a brief window where Start throws. Duplicate blocker rows are
  inserted with no dedup (`db.ts:345`). Server restart loses in-flight crawls and the event timeline
  (in-memory only); `running` sessions are recovered to `failed`.
- **[P2] Same-origin filter is strict** (`crawler.ts:1046`) — `www.` vs apex and subdomains are
  dropped. Default exclude patterns (`/admin`, `/logout`, …) silently skip real routes
  (`discovery-view.tsx:22`).
- **[P2] Loader mislabels blockers.** `loadSiteKnowledge` maps **every** blocker URL to
  `authRequiredRoutes` (`knowledge-loader.ts:69`), so captcha/manual URLs are shown to the agent as
  "authentication required." Route catalog capped at 60 (`knowledge-loader.ts:18`).
- **[P2] Auth detection false positives/negatives.** Broad `/auth/` + `/forbidden/i` on full page
  text (`detectors/auth.ts`) can pause on marketing/legal pages; magic-link/OAuth-only flows can
  slip through.

---

## 7. CLI / server / interactive REPL

**What it does.** `raiken` (no subcommand) now launches the in-process REPL (`bin.ts` default
action → `chat.ts`): readline loop → natural language via `runOrchestrator` (with live `onToolCall`)
or slash-commands (DOM via `BrowserSession`, parity via existing handlers + a tRPC caller). `raiken
start` runs the dashboard server. Both share `bootstrapProject` (`bootstrap.ts`).

### Findings

- **[P0] Parity slash-commands kill the whole REPL.** `/doctor` (`doctor.ts:42`), `/ci`
  (`ci.ts:86`), `/trace` (`trace.ts:37`), `/discover` with no URL or on error (`discover.ts:246`),
  and several `/auth` failure paths (`auth.ts:104`) call `process.exit()`. Because the REPL reuses
  the one-shot command handlers directly, running any of these **terminates the interactive
  session**. This is the most severe new-feature bug.
- **[P1] Idle Ctrl-C exits immediately.** The comment promises "second Ctrl-C exits," but when idle
  `currentAbort` is null so the **first** Ctrl-C calls `shutdown()` (`chat.ts:110`). Ctrl-C during
  the HITL save prompt also exits instead of cancelling (`chat.ts:133`).
- **[P1] Stop doesn't really stop, and can then exit.** Abort is between-nodes only (`agent.ts:771`),
  so the REPL stays blocked in the `for await` after "Stopped"; a second Ctrl-C (now
  `currentAbort=null`) falls through to `shutdown()` and quits the session.
- **[P1] HITL marker parsing breaks on `-->` inside the payload.** `splitHITL` uses a non-greedy
  regex (`chat.ts:16`); if generated `testCode` contains `-->` the marker terminates early, JSON
  parse fails silently, and the save prompt never appears.
- **[P2] CLI history is process-local** (`chat.ts:77`) — lost on exit (also noted in §1).
- **[P2] `getGraphFiles` ignores the caller context.** It uses `process.cwd()` not
  `ctx.projectPath` (`router.ts:1124`) — fine today, fragile if cwd ≠ bootstrap path.
- **[P2] No Playwright preflight.** `ensureBrowser` launches Chromium with no "run npx playwright
  install" hint (`chat.ts:89`); a missing browser surfaces as a raw exception.
- **[P2] `/fill`/`/type` need a literal ` = ` delimiter** (`chat.ts:382`) and `/snapshot` force-
  starts the browser with no "no page" soft path.
- **[P2] Two watchers if both run.** `raiken` and `raiken start` each call
  `ProjectContext.startWatching()` on the same DB — duplicate indexing / lock contention, unguarded.

---

## 8. Cross-cutting themes (the root causes)

1. **No mid-run streaming or progress.** The graph runs to completion before any output; the
   dashboard gets no tool events at all. Everything feels frozen and unreliable even when it works
   (§2, §7).
2. **Actions don't return state; the agent reasons on stale DOM.** No post-action re-capture, no
   verification, `.first()` masks wrong-element hits (§3). This alone explains most "DOM doesn't
   work."
3. **Grounding is bypassed as often as it's used.** The default test path skips the browser, drops
   `domSummary`/`currentUrl` between turns, truncates context, and doesn't validate selectors — so
   the model invents routes and locators (§2, §4).
4. **Memory write/read asymmetry.** 10-message window, stale goals auto-applied, exploration wiped
   by unrelated pauses, test-outcome learning unimplemented (§1).
5. **No concurrency guards on user actions.** Run/save/fix/analyze and discovery Start/Continue/
   Clear have weak or missing in-flight guards; repeated or overlapping clicks corrupt state or
   race (§5, §6).
6. **State clobber in the editor.** Disk-load-on-focus and name-based tab dedup destroy unsaved
   work (§5).
7. **REPL reuses process-exiting handlers.** The new interactive shell dies on common commands (§7).

---

## 9. Prioritized defect list

**P0 — fix first (breaks core UX or loses data)**

1. Agent sees only 10 chat messages — `sidebar.tsx:1170`.
2. No streaming/progress during a run — `agent.ts:771`, `context.ts:372`, `server.ts` (no `onToolCall`).
3. Same request → blind vs live generation — `graph.ts:55`.
4. Interactions return no new DOM/URL; agent runs on stale state — `tools.ts:975/1008`.
5. `.first()` silently acts on the wrong element with `success:true` — `session.ts:616`.
6. Interaction tools don't auto-start the browser — `tools.ts:973+`.
7. Blind generation + "use ONLY [LIVE DOM]" contradiction; no selector validation — `prompts.ts:122`, `context.ts:325`.
8. Unsaved edits clobbered on tab switch / focus — `testing-view.tsx:451`, `main.tsx:87`.
9. Name-based tab dedup conflates/wipes files — `testing-view.tsx:488/984`.
10. Discovery queue persistence broken → resume loses work — `crawler.ts:1580/370`.
11. SPA routes without `<a href>` never discovered — `crawler.ts:1267`.
12. Parity slash-commands `process.exit()` and kill the REPL — `doctor.ts:42`, `ci.ts:86`, `trace.ts:37`, `discover.ts:246`.

**P1 — frequent wrong results** (see per-section lists): stale goal/exploration restore & dropped
`currentUrl` (§1); misclassification → essay instead of test, `isContinuation` guardless, no
dashboard tool events (§2); no post-action verification, `<select>` via `fill`, 5s timeouts, 30-of-80
elements, drop of parsed elements (§3); baseURL detection, discovery-URL vs relative rule, lost
second-turn DOM, gate ignores site knowledge, auth block conditional, marker not stripped on save
(§4); overlapping runs, wrong-tab status, double-fix window, analyze/fix read disk not buffer, ghost
temp tabs (§5); query-string collapse, stale snapshots on re-visit, Start-while-paused, auto-resume
races (§6); idle Ctrl-C exits, stop-then-exit, HITL `-->` parsing (§7).

**P2 — rough edges:** truncation caps, testDir vs config mismatch, iframe/overlay gaps, missing
agent tools (`type`/`hover`), duplicate-tab stale closure, tab reordering, blocker mislabeling,
duplicate blocker rows, two file watchers, CLI history not persisted — see each section.

---

## 10. Suggested sequencing (not yet implemented)

1. **Make the agent feel alive:** stream tool events to the dashboard (`onToolCall` in `server.ts`)
   and stream the generate step; this fixes the dominant "feels broken" perception.
2. **Close the DOM-action loop:** re-capture + return URL/DOM after every click/fill, drop the
   silent `.first()` (or report ambiguity), auto-start the browser in every interaction tool.
3. **Always ground test generation:** route generateTests through the browser when a base URL is
   known; restore `domSummary`/`currentUrl` between turns; validate selectors before returning.
4. **Fix memory:** raise/redesign the conversation window; clear goal/exploration on completion;
   stop wiping exploration on non-exploration pauses; persist CLI history.
5. **Guard user actions:** run id + server lock for runs; path-only tab keys; dirty-buffer guard;
   fix the fix/analyze in-flight lifecycle; exclude temp specs from the graph.
6. **Discovery reliability:** fix queue persistence, add JS/SPA route discovery, refresh snapshots
   on re-visit, guard Start-while-paused and resume races.
7. **REPL robustness:** run parity commands without `process.exit` (refactor handlers to throw, or
   run them out-of-process), fix Ctrl-C semantics, harden HITL marker parsing.

---

*End of audit. Every claim above is anchored to `file:line`; drill into any section on request and
I can turn it into a fix plan.*
