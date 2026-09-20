# Core Review — application (root services + discovery application)

**Scope:** `libs/core/src/application/` — root services (testing, indexing, config, quality, registry, chat, hitl, paths, discovery-query-cache, index; ~1,667 ln) + `application/discovery/` (12 files, ~2,200 ln)
**Method:** direct line-by-line read in-session (agent delegation failed twice per scope). Report-first — no changes made.

## Findings

| Severity | Location | Issue | Why it matters | Fix direction |
|---|---|---|---|---|
| medium | libs/core/src/application/discovery/listeners.ts:100-140 | handleBlockerEvent increments `authBlockersFound` for EVERY blocker category (L121, L126) and pushes non-auth blockers as event type `auth_blocked` (L131) — the application-layer twin of the crawler-side stat bug (request-handler.ts:196) | Dashboard runtime state counts captcha/consent/manual walls as auth blockers, and the timeline labels them "auth_blocked" — wrong diagnosis on both surfaces from two independent increments | Count only category auth_required; use a distinct event type per category (fix with the crawler-side finding) |
| low | libs/core/src/application/testing.ts:415-417 | deleteTestFile: `db.close()` not in finally (contrast renameTestFile :464-470 which does it right) | If deleteTestRecords throws, the better-sqlite3 handle leaks | try/finally like the rename path |
| low | libs/core/src/application/indexing.ts:112-114, 138-140, 168-171, 341-344, 357-359 | Five sync open→query→close sequences without try/finally; searchCode (:293-336) closes in success path, early return, AND catch — double-close-prone (better-sqlite3 throws "already closed", downgraded to a warn) | Handle leak on DB-method throw; inconsistent close idiom across one file | Standardize on try/finally |
| low | libs/core/src/application/testing.ts:542-571 | listTestFiles scanDir: a throw from deriveStatus mid-directory (e.g. getSourceFilesForTest SQLITE_BUSY at :530, outside any inner try) is caught at :568 and silently aborts that directory's remaining entries | Partial file listing with no signal to the dashboard | Per-entry try/catch; surface a partial flag |
| low | libs/core/src/application/discovery/auth-resume.ts:92-94, 114-116 | Unguarded JSON.parse on persisted skippedUrlsJson / ignoredCategoriesJson | One malformed legacy value breaks Continue with a raw error (repos use safeJsonArray elsewhere) | Use the shared safe helpers |
| low | libs/core/src/application/discovery/query-facade.ts:141-147 | getVerifiedLinks opens its own CodeGraphDB per call, bypassing the cached DiscoveryQueryService the class exists to front | Per-call open cost (sqlite-vec load, pragmas, 8 schema ensure-checks, TRUNCATE checkpoint on close) on a dashboard hot path | Add getVerifiedLinks/getBrokenLinks to the cached query service |
| note | libs/core/src/application/indexing.ts:41-48 | buildCodeGraph(input.path) resolves a SUBPATH and CodeGraphDB derives .raiken/raiken.db from it — indexing a subdirectory creates a separate DB instead of a project-scoped index | Possibly intended (scoped indexes) but undocumented; users indexing a package get a fragmented graph | Document, or anchor the DB to the registered project root |
| note | libs/core/src/application/discovery/application.ts:327-343 | Manual pause saves a `manual` category blocker on every pause (deduped by saveBlocker's url+category+detector semantics) | Pollutes the blockers table with UI actions; getUnresolvedBlockers consumers see manual rows | Consider a session flag instead of a blocker row |
| note | libs/core/src/application/discovery/handoff.ts:46-52 | handoffJobStore has-then-set race — mitigated by the ProjectOperation lease conflict | Two concurrent handoff requests: second fails on OPERATION_BUSY — acceptable | — |
| note | libs/core/src/application/testing.ts:452-460 | renameTestFile conflict check via try/access/throw-then-rethrow-on-message | Functional but convoluted; message-string matching is fragile | Invert with existsSync |

Clean: registry.ts (discovery-aware LRU eviction, never drops an active discovery owner), project-runtime.ts (handoff abort lifecycle), state.ts, hydration.ts, types.ts, chat.ts, hitl.ts, paths.ts (containment wrapper), ConfigApplication.updateConfig (validates the MERGED config before atomic write), QualityApplication (thin orchestration; dashboard runCi defaults skipRun=true).

## Strengths
- execution.ts's finally cascade is exemplary: discovery.close() → jobStore.delete → lock.release → deferred background cleanup with a 30s identity-checked timeout (unref'd) so a finished run can't clobber a newer one.
- state-hydrator.ts guards against the phantom-"Running" badge (documented rationale), runs stale-session recovery when no job is in flight, and auto-resumes after blockers cleared — with an in-flight guard and fresh-auth purge-queue logic.
- DiscoveryApplication pause/abort/clearData paths hold correct locks, write resumable session state, and release everything in finally.
- Read-model facade never lets DB errors crash dashboard queries (typed empty fallbacks).
- The registry eviction policy (never dispose an active-discovery bundle) prevents a cache sweep from killing a live crawl.

## Test-coverage observations
(structural — specs not read line-by-line for this module)
- No spec pins blocker-stat category accuracy (the medium finding) at either the crawler or listener layer.
- deleteTestFile/leak-on-throw, listTestFiles partial-failure, auth-resume malformed session JSON, and subdirectory indexing behavior are all untested contracts worth specs.
- The execution.ts finally-cascade (job deleted + lock released when the crawler throws during start) deserves a regression spec — it's the crash-recovery backbone.

## Verdict
**minor fixes needed** — the blocker-stat/event miscount is the one user-visible correctness issue (shared with the crawler module); the rest is close-discipline hygiene in an otherwise very well-orchestrated layer.
