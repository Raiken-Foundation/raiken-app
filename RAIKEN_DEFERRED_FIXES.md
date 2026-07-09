# Deferred fixes — behavior trade-offs or concurrency risk

> Companion to `RAIKEN_SYSTEM_AUDIT.md`. These items were verified still present against
> current code but were **not** implemented alongside the low-effort fixes in this pass,
> because each either changes default behavior for existing users, touches concurrency-
> sensitive code, or is real feature work rather than a bug fix. Each entry has what's
> wrong, why it's risky to change now, and a suggested approach — ready to pick up when
> prioritized.

---

## 1. Query-string collapse default (`preserveQueryParams`)

**What's wrong:** `normalizeUrl` (`libs/core/src/site-discovery/url-utils.ts`) strips all
query params unless `preserveQueryParams: true` is set. The option is fully wired end to
end (`crawler.ts` → `router.ts` → `config/schema.ts`), but the default is `false`, so
`/product?id=1` and `/product?id=2` collapse into a single DB row/page for every project
unless the user manually edits `raiken.config.json`.

**Why it's risky:** Flipping the default changes crawl characteristics for every existing
project, not just ones with the bug. Sites with lots of query-string variation (pagination,
filters, sort params, tracking params) would suddenly have every variation treated as a
distinct "page," which can:
- Fill `maxPages` with query variations instead of reaching genuinely distinct routes.
- Bloat the discovered-pages table and the `[SITE DISCOVERY KNOWLEDGE]` prompt section with
  near-duplicate routes.
- Change crawl duration/behavior for users who were implicitly relying on collapsing.

**Suggested approach:** Don't flip the global default. Instead, either (a) auto-detect when
a route has meaningfully different query-driven content (e.g. compare page snapshots for a
sample of query variants before deciding to preserve params for that route), or (b) surface
the toggle in the dashboard's discovery config UI (currently config-file-only) so users can
opt in per project without a code change, with documentation explaining the trade-off.

---

## 2. Clear during a running crawl is racy

**What's wrong:** `clearDiscoveryData` (`libs/shared/src/lib/router.ts`) calls
`discovery.close()` and then wipes the `discovered_pages`/`discovered_links`/
`discovery_blockers` tables. `close()` tears down the Crawlee crawler but does not set
`aborted`/`isPaused` on the `SiteDiscovery` instance, so an in-flight `handleRequest` handler
can still be mid-way through writing to `siteDb` when the tables get wiped underneath it.

**Why it's risky:** This is genuinely concurrency-sensitive. The fix needs to correctly
sequence `abort()` (which does set the flags) before `close()`, then await the background
job's promise so no handler is still running before the wipe starts — and needs to be tested
against real timing (a crawl mid-`page.evaluate()` when abort fires), not just the happy
path. Getting the sequencing wrong could introduce a hang (if the awaited promise never
resolves because a browser call is stuck) or a UI regression (Clear becoming slow to
respond).

**Suggested approach:** In `clearDiscoveryData`, call `await runningJob.discovery.abort()`
(not just `close()`), then `await runningJob.promise` (the background job promise from
`startDiscoveryJob`) with a timeout guard, then wipe tables. Add a generation
token/version-stamp per session so any write that somehow lands after the wipe is a no-op
rather than silently resurrecting rows.

---

## 3. Auto-resume vs. manual Continue race

**What's wrong:** `hydrateDiscoveryState` (`libs/shared/src/lib/router.ts`) auto-resumes a
crawl when all blockers clear (polling-driven), while the dashboard's blocker-resolution
handoff (`discovery-view.tsx`) also explicitly calls `continueMutation`. Guards exist
(`autoResumeInFlight`, `discoveryJobStore.has` checks) but a narrow window remains where both
paths can reach `startDiscoveryJob` in the same tick, and the loser throws "already running"
instead of resuming cleanly.

**Why it's risky:** This needs a proper per-project mutex/coordinator, not just another flag
check, to fully close — and the current guards already handle the common case, so the
remaining window is narrow and easy to get subtly wrong (e.g. a mutex that's held too long
and blocks a legitimate manual Continue after a real auto-resume failure).

**Suggested approach:** Introduce a single per-project "resume coordinator" — one place both
the poller and the handoff success callback call into, which either starts the resume or
no-ops if one is already in flight/succeeded, and returns a normal `{ alreadyRunning: true }`
result instead of `startDiscoveryJob` throwing.

---

## 4. Same-origin `www.`/subdomain normalization

**What's wrong:** `safeOrigin`-based same-origin filtering in `crawler.ts` uses strict
`URL.origin` equality, so `https://www.example.com` and `https://example.com` are treated as
different origins — links to one from the other are dropped as "off-site," and subdomains are
never followed.

**Why it's risky:** This is an intentional security/scope boundary as much as a bug. Some
sites deliberately split `www` and apex (different apps, different auth, marketing vs. app),
and some legitimately want subdomains excluded (docs.foo.com vs app.foo.com). A blanket
"strip www" normalization would incorrectly merge sites that are supposed to be separate for
some users.

**Suggested approach:** Make it configurable — an `allowedHosts`/`includeSubdomains` option
in discovery config (similar to `excludePatterns`) rather than a global behavior change, so
projects opt in explicitly.

---

## 5. Resume crawls after server restart

**What's wrong:** On server restart, `failStaleSessions()` marks any `"running"` discovery
session as `"failed"` since the in-memory `discoveryJobStore` (which holds the actual Crawlee
crawler/job) is empty after restart — there's no way to resume the in-process job, so
today's behavior is the safest available option, not a bug per se.

**Why it's deferred:** Actually resuming would need the crawl to be resumable purely from
persisted state — reconstructing a `SiteDiscovery` instance from `queue_json` +
`discovered_pages` and restarting Crawlee — which is a real feature (job persistence /
recovery), not a small fix, and needs design for what "resume" means across a restart (same
browser context? re-verify already-discovered pages? auth state still valid?).

**Suggested approach:** When hydration detects a stale `"running"` session with a
non-empty queue snapshot, surface it in the dashboard as "Interrupted — click Resume" instead
of silently failing it, and only then invest in wiring an actual resume path.

---

## 6. Learn-from-test-runs unimplemented

**What's wrong:** `AgentMemory.recordTestGenerated`, `recordTestResult`, and
`setSelectorStrategy` (`libs/core/src/agent/memory.ts`) are fully implemented but have zero
callers outside `memory.ts` itself. `recentFailures` and `selectorStrategy` in the generation
prompt are therefore always empty — the agent never actually learns from past test runs.

**Why it's deferred:** This is real feature work, not a bug fix: it needs call sites wired
into the test runner (`libs/core/src/testing/runner.ts`) to record outcomes after every run,
a decision on what "learning" should influence (selector strategy ranking? avoiding
previously-failing selectors? surfacing flaky tests?), and prompt changes to consume the
data usefully rather than just adding noise.

**Suggested approach:** Start narrow — after a test run, call `recordTestResult` with
pass/fail + failing selector (if any); after several failures on the same selector pattern,
surface a short "known flaky selector" hint in the generation prompt. Ship that as its own
scoped change with its own tests rather than folding it into a mixed fix batch.

---

## 7. Two divergent pause paths in the agent graph

**What's wrong:** Browser/interruption pauses go through the `awaitUser` node/tool
(`graph.ts` → `interruptions.ts`), while save/run HITL pauses (`hitl.ts`) set `shouldPause`
and jump straight to `END`, skipping the `awaitUser` node entirely. UX is unified at the
stream layer (`agent.ts` post-processes `finalState.awaitUserMessage` either way), but the
graph topology itself is inconsistent.

**Why it's risky:** Unifying them means changing graph edges/conditional routing
(`graph.ts`), which is exactly the kind of change that can silently alter HITL behavior in
ways only caught by exercising every pause scenario (auth blocker, consent wall, save
approval, run approval, repair loop) end-to-end. Given HITL correctness is core to user
trust, this warrants its own dedicated pass with full manual + automated regression testing,
not a bundled quick fix.

**Suggested approach:** Route `hitlSave`/`hitlRun` pauses through the `awaitUser` node too
(so there's one pause mechanism, one place that emits the `awaitUser` tool call), keeping the
existing HITL marker/approval UX unchanged — then verify with a matrix of all pause types.

---

## 8. Interruption pre-filter fires on any textbox

**What's wrong:** `shouldClassifyInterruption` (`libs/core/src/agent/graph/utils.ts`)
triggers the interruption-classification LLM call whenever the page has *any*
`textbox`/`combobox` element (excluding checkbox/radio) — a search bar or comment field on an
otherwise normal, logged-in page still pays for an extra classification call.

**Why it's deferred:** The existing code comment states this breadth is intentional — a
narrower filter risks missing real auth/consent walls that happen to render as something
other than the exact textbox pattern being matched. Narrowing this requires a broader survey
of what real auth/consent pages actually look like (structurally) to find a filter that's
both narrower and doesn't regress the interruption-detection recall the current code was
tuned for.

**Suggested approach:** Instrument this in a real project first (how often does the
classifier fire on non-blocker pages vs. actual blockers) before changing the filter, so any
narrowing is validated against real hit/miss rates rather than guessed.

---

## 9. ARIA `combobox` (non-native `<select>`) still `fill()`-only

**What's wrong:** `BrowserSession.fill()` now detects a native `<select>` element and routes
to `selectOption` (already fixed). Custom ARIA `role="combobox"` widgets (common in
component libraries — Radix, MUI, custom design systems) are not native `<select>` elements
and still go through `fill()` only, which may not correctly drive them (many custom
comboboxes need a click to open + a click on an option, not a text fill).

**Why it's deferred:** There's no single interaction pattern for ARIA comboboxes — some
accept typed input with filtering, some require open+click, some are read-only triggers.
Handling this properly needs its own small interaction-strategy (detect `aria-haspopup`/
`aria-expanded`, try click-to-open then option-click, fall back to fill) and testing against
a few real component libraries, not a one-line change.

**Suggested approach:** Add a dedicated combobox-handling path in `session.ts`'s
`runWithSelectors`/`fill` that, for `role="combobox"` elements, tries click-open + type +
option-select before falling back to plain `fill()`.

---

## 10. No user-facing ambiguous-selector warning

**What's wrong:** When a selector resolves to multiple elements, `runActionWithStrictRetry`
(`libs/core/src/browser/session.ts`) already prefers the first *visible* match (an
improvement over blind `.first()`), but the tool result still reports plain `success: true`
with no indication that the selector was ambiguous.

**Why it's deferred:** Surfacing this changes what the agent sees on every ambiguous action,
which is a moderate prompt-behavior change — it could cause the model to second-guess/retry
actions that were actually fine (the visible-first heuristic is usually correct), adding
latency/noise for a case that already resolves acceptably most of the time.

**Suggested approach:** Add a `message` suffix like `" (note: selector matched N elements,
acted on the first visible one)"` only (not a `success: false`), so the agent has the signal
available in context without treating it as a hard failure — then observe whether it changes
agent behavior for better or worse before deciding whether to also add a retry/disambiguation
step.
