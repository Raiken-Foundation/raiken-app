# Core Review — site-discovery/crawler

**Scope:** `libs/core/src/site-discovery/crawler/` (11 source files, ~1,350 lines)
**Method:** delegated line-by-line review (all files read completely; specs skimmed; Crawlee 3.16 and playwright-core 1.57 behavior verified against their sources). Report-first — no changes made.

## Findings

| Severity | Location | Issue | Why it matters | Fix direction |
|---|---|---|---|---|
| high | libs/core/src/site-discovery/crawler/storage-state.ts:31-41 | Sanitizer passes cookies Playwright's context creation hard-rejects: cookie with neither `url` nor `domain`, `domain` without `path`, or `expires < -1` (verified against playwright-core 1.57 rewriteCookies asserts) | With a storageState loaded, every `browser.newPage({storageState})` throws → browser-pool retires the controller → EVERY request fails → authenticated crawl produces zero pages with a confusing error. This is exactly the third-party/older-Chromium auth-state.json class the docblock claims to sanitize | Drop cookies lacking url+domain; default `path: "/"`; clamp expires; force `secure: true` when sameSite "None" (Chromium silently drops None-without-secure) |
| high | libs/core/src/site-discovery/crawler/link-extraction.ts:99 | `querySelectorAll` in a single main-frame evaluate — no shadow-DOM piercing | Nav links inside shadow roots (Lit/Stencil/Material web components) are invisible → whole route subtrees never discovered. Inconsistent with ariaSnapshot (request-handler.ts:298) which DOES pierce shadow DOM, so snapshots and link graphs disagree | Traverse `element.shadowRoot` recursively, or derive link candidates from the a11y/ariaSnapshot tree |
| medium | libs/core/src/site-discovery/crawler/form-extractor.ts:48-54 | Same light-DOM/main-frame-only extraction for inputs (and submits at 74-78) | Form fields inside shadow roots (Shoelace/FAST/Lion) or iframes missing from forms_json → AI test generation guesses fields | Same recursive traversal; consider page.frames() for same-origin embedded forms |
| medium | libs/core/src/site-discovery/crawler/request-handler.ts:243-245, 510-515 | After `deps.pause(...)`, handler sets `committed = true` and its `finally` deletes the queue entry that `SiteDiscovery.pause()` (crawler.ts:339-356) just re-created with `resumeBlocked: true`, then marks URL visited | Resume only works because pause() happens to persist queueJson to DB BEFORE the handler's finally deletes the in-memory entry — hidden ordering dependency; if resume runs on the same instance, visitedUrls silently discards the auth-blocked URL forever | Don't mark pause-path returns committed for queue/visited purposes, or have pause() re-add after handler unwinds |
| medium | libs/core/src/site-discovery/crawler/request-handler.ts:196 | `stats.authBlockersFound++` fires for EVERY blocker (captcha, paywall, consent…), not just auth | Empty-crawl error (runtime-setup.ts:42-46) then tells users to run `raiken auth` for a captcha wall — wrong diagnosis; dashboard stat inflated | Increment only for category "auth_required", or rename stat and branch the message |
| medium | libs/core/src/site-discovery/crawler/runtime-setup.ts:125-154 | `buildPlaywrightCrawler` never sets `maxRequestRetries`; Crawlee BasicCrawler defaults to 3 (verified 3.16 source) | A dead URL costs 3 full attempts × (navTimeout + networkidle + settle) — starves reachable pages under the wall-clock cap on link-heavy sites | Set `maxRequestRetries: 1` (or 2) explicitly; Raiken has its own resume/checkpoint machinery |
| low | libs/core/src/site-discovery/crawler/runtime-setup.ts:118-121 vs 157-168 | Timeout/request-cap math duplicated: inline copy in buildPlaywrightCrawler vs computeCrawleeRequestCap/computeHandlerTimeouts (spec-only) | Tested helper can pass while production drifts | Call the helpers from production (or delete inline copies) |
| low | libs/core/src/site-discovery/crawler/request-handler.ts:520-534 | `runDetectorPipelineForPage` exported from production file but used only by the contract spec | Test-only surface in shipped module | Move into the spec or mark @internal |
| low | libs/core/src/site-discovery/crawler/request-handler.ts:153-157 | `skippedUrls` consulted only AFTER full navigation + waits, then marks inbound links `status: "broken"` ("Skipped by user") | Skipped URLs pay a full page load each run; "broken" is semantically wrong for deliberate skips | Check skippedUrls before waits; use a distinct status |
| low | libs/core/src/site-discovery/crawler/request-handler.ts:63-79 | In waitForDomQuiet, `page.waitForTimeout(100)` not inside the catch — teardown mid-settle propagates and records a bogus "navigation failure" | Deliberate teardown pollutes failure diagnostics driving the empty-crawl error path | Wrap the loop body / check page.isClosed() |
| low | libs/core/src/site-discovery/crawler/checkpoint-scheduler.ts:24-32 | `armCheckpointTimer()` doesn't clear an existing timer before assigning | Double-arm leaks an interval (two concurrent persist loops) | Disarm first or no-op if armed |
| low | libs/core/src/site-discovery/crawler/checkpoint-scheduler.ts:44-46 | Wall-clock cap reported via console.warn, not the emit event channel | Dashboard/CLI event stream never sees WHY the crawl paused | Emit a session_paused payload with reason wall_clock_cap |
| low | libs/core/src/site-discovery/crawler/storage-state.ts:73-83 | auth-state.json read twice (inspectAuthState + readFileSync); catch collapses all errors into one generic string | TOCTOU + wasted IO; JSON syntax error gives no pointer to the problem | Parse once; include the underlying message |
| low | libs/core/src/site-discovery/crawler/link-extraction.ts:28, 97-101 | MAX=250 cap silently truncates; `a[href]` can consume the budget before `[role="link"]`/data-attr elements are examined | Link-heavy pages lose nav candidates with no signal; prioritization accidental | Interleave selector groups or raise cap for structural selectors; emit telemetry on truncation |
| low | libs/core/src/site-discovery/crawler/failure-summary.ts:17 | Any "Timeout … exceeded" summarized as "Navigation timeout", incl. handler/evaluate timeouts | Mislabels failures in user-facing reports | Distinguish requestHandler vs navigation timeouts |
| note | libs/core/src/site-discovery/crawler/exclude-patterns.ts:20-25 | Glob matchers unanchored (substring semantics); bare `*` compiles to `[^/]*` matching nothing with "/" | Surprising vs glob-root expectations (documented, though) | Anchor at "/" boundaries or document in CLI help |
| note | libs/core/src/site-discovery/crawler/link-extraction.ts:50-54 | isLikelyRoute requires "/" or extension in relative hrefs — bare `href="page2"` dropped | Under-discovery on non-slash relative sites; defensible heuristic | Accept bare same-origin relative segments |
| note | libs/core/src/site-discovery/crawler/process-wide-lock.ts:7-17 | No stale-lock recovery; release only on catch path and close() | Abnormal unwind locks discovery until process restart (current callers always close()) | Release in a finally around the whole run |

Clean: browser/page lifecycle NOT leaking — Crawlee closes pages per request, owned-context auto-close cascades to popups, teardown under the process-wide lock; no screenshot/trace buffers held (ariaSnapshot strings only, sliced/capped); concurrency budget exact via the synchronous re-check before commit.

## Strengths
- Single-evaluate DOM extraction eliminates N+1 CDP round-trips and stale-element races; extractors are total functions (catch → []/null) so capture failures never abort the crawl.
- Pre-commit budget re-check (request-handler.ts:324-330) is synchronous from check to DB write — maxPages exact under any concurrency; committedUrls dedupe reconciles run summaries with persisted rows (redirect-then-direct regression-tested).
- Link verification variant-aware (raw/normalized/trailing-slash/index.html candidates) with commit-time spot-verification plus end-of-run sweep.
- Bounded everything: failure reports ≤5, URL samples ≤5, text slices, queue JSON bounded by request cap, timers unref'd and disarmed in finally.
- Logout-URL guard (record the link, never navigate while a session is loaded — request-handler.ts:486) protects the restored session; spec-covered incl. seed-side re-filter on resume.

## Test-coverage observations
- link-extraction.ts has ZERO direct spec coverage (always mocked in request-handler.spec) — isLikelyRoute heuristics, visibility filter, MAX truncation, selector precedence untested; the shadow-DOM gap invisible to the suite.
- storage-state.ts has no spec at all — one integration test with a sanitized third-party cookie would have caught the high-severity Playwright rejection.
- exclude-patterns.ts (compileExcludeMatcher) — no spec anywhere.
- waitForDomQuiet never exercised (request-handler.spec omits settleQuietMs).
- request-handler.spec doesn't cover: budget re-check race, pause→finally interplay, HTTP ≥400 incl. synthetic 59x, off-origin redirects, skippedUrls, depth discard.
- No spec for popups/download-triggering links/about:blank redirects.
- form-extractor.integration.spec closes its browser only on success (empty afterEach) — failed assertions leak chromium; checkpoint-scheduler arm/disarm/onCap untested.

## Verdict
**needs fixes** — the storage-state sanitizer passes cookie shapes Playwright hard-rejects (kills authenticated crawls entirely) and both DOM extractors are blind to shadow DOM/iframes, silently under-discovering on modern component-based sites; everything else is medium-or-below hygiene.
