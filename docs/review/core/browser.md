# Core Review — browser

**Scope:** `libs/core/src/browser/` (13 files, ~3,175 lines, incl. session/)
**Method:** delegated line-by-line review (all 13 source files read fully; specs skimmed; lifecycle/selector correctness prioritized). Report-first — no changes made.

## Findings

| Severity | Location | Issue | Why it matters | Fix direction |
|---|---|---|---|---|
| high | libs/core/src/browser/interactive-auth-handoff.ts:361-377 | Browser launched with no try/catch around `newContext`, `newPage`, or caller-supplied `onBrowserReady?.()`; error handling starts only after race setup | Any throw there rejects with no `browser.close()` → zombie Chromium. `onBrowserReady` is external UX-adapter code, so reachable without Playwright itself failing | Wrap context/page creation + onBrowserReady in try/catch that closes the browser before rethrowing |
| medium | libs/core/src/browser/session.ts:580-591 | `loadAuthState` closes the old context then swaps; on `newContext`/`newPage` rejection the fields still reference the closed context/page | `isActive()` (166-174) stays true (`page.url()` doesn't throw on a closed page) — session looks healthy while every action fails "Target closed" | Null out context/page on swap failure so isActive() is honest |
| medium | libs/core/src/browser/session/registry-store.ts:85-92 | `forceClose` release deletes lease state and closes the session regardless of outstanding `refs > 0` | One leaseholder's abort kills the shared browser mid-click/fill for concurrent leaseholders | Only close when refs reach 0, or broadcast so holders re-launch |
| medium | libs/core/src/browser/custom-login-runner.ts:246-251 | Catch re-wraps every `runPlaywright` error as plain `Error`, including the AbortError DOMException thrown at :159 | Cancellation identity destroyed; signal-aware callers (dashboard checks `error.name === "AbortError"`) misclassify cancelled logins as failures | Re-throw AbortError/DOMException untouched; wrap only non-abort errors |
| medium | libs/core/src/browser/session/selector-utils.ts:86 | `input[name="${htmlName}"]` interpolates unescaped — `buildFieldSelector` escapes the same attribute (44, 47) | A name with `"` or `\` yields broken CSS that silently never matches (count 0 → skipped) — degrades generated tests | Apply the same esc() used in buildFieldSelector |
| medium | libs/core/src/browser/session/selector-utils.ts:44-50, 71-72 (+ interaction-strategies.ts:167-169) | Escaping gaps and 3 divergent implementations: getBy* literals escape `'` but not backslash/newline; id escape sets differ and none handle digit-leading ids (`#1abc` invalid CSS) | Wrong selectors corrupt every generated test; digit ids break the aria-controls popup lookup (interaction-strategies.ts:124) silently | Centralize one escape module; CSS.escape semantics for ids, JS-literal escaping for getBy* args |
| medium | libs/core/src/browser/session/locator-resolver.ts:66-73 | `nameMatch` regex requires `}` right after the name; `getByRole('button', { name: 'Go', exact: true })` degrades to `getByRole('button')` — name silently dropped | Over-broad locator → strict-mode violation → first-visible retry (233-259) may click the WRONG control | Parse options fully or refuse rather than drop constraints |
| medium | libs/core/src/browser/interactive-auth-handoff.ts:381-484 | Shared mutable `reason` written by five async racers; a disconnect/timeout callback landing between detection (:460) and capture (:484) flips a stable detected login to browser-closed/timeout | shouldPersistHandoffState (337-339) then refuses to persist a genuinely valid session — user re-does the login for nothing | Race on resolved `{reason}` values instead of mutating shared state |
| low | libs/core/src/browser/session.ts:244-246 + playwright-loader.ts:9-34 | `doStart` imports "playwright" directly; the loader's playwright-core fallback is used only by the handoff; `tryLoadPlaywrightChromium` has zero callers | playwright-core-only installs: auth handoff works but every BrowserSession.start() fails with a raw module error | Route doStart through the loader; delete or adopt tryLoadPlaywrightChromium |
| low | libs/core/src/browser/session.ts:418-421 | `actionTimeoutMs()` silently clamps configured timeout into [5s, 15s] | browser.timeout: 60000 still yields 15s action timeouts — actions fail while navigation honors 60s | Document the clamp or only lower defaults |
| low | libs/core/src/browser/session/selector-utils.ts:16 | classifySelector tests `/data-testid=/` before the xpath check (:28) | `xpath=//div[@data-testid='x']` misclassified — skews selector-reliability analytics | Anchor the check or check xpath prefixes first |
| low | libs/core/src/browser/session/dom-snapshot-builder.ts:97 | `isExternal: !fullUrl.startsWith(currentOrigin)` — prefix, not origin, equality | `https://example.com.attacker.com` classified internal against `https://example.com` | Compare `new URL(fullUrl).origin === currentOrigin` |
| low | libs/core/src/browser/custom-login-runner.ts:286-296 | Temp `playwright.config.raiken-auth-*.ts` written into the user's config dir | Crash-leftovers accumulate and can be committed; sweep covers specs, not configs | Write under `.raiken/` or extend the sweep |
| low | libs/core/src/browser/session.ts:527-534 | Page-recovery reassigns `this.page` without re-applying setDefaultTimeout (set only at launch :265) | Recovered page silently loses the configured default timeout | Re-apply on adoption |
| note | libs/core/src/browser/session.ts:181-191 | Concurrent `start()`: second caller's options silently ignored | Surprising with different options | Merge/queue or assert equality |
| note | libs/core/src/browser/session.ts:311-334 | navigate retry: no backoff, intermediate errors swallowed | Hammers struggling server; loses diagnostics | Delay + accumulate errors |
| note | libs/core/src/browser/session.ts:489-498, 544-547 | Deprecated waitForNavigation; screenshot not wrapped in BrowserActionError | Consistency/future-proofing | waitForURL; wrap screenshot |
| note | libs/core/src/browser/session/locator-resolver.ts:216-225 | waitForSelector final fallback re-waits full timeout on list[0] after all scopes reported 0 | Doubles worst-case wait | Skip fallback when main scope reported 0 |
| note | libs/core/src/browser/interactive-auth-handoff.ts:368 | `options.url ?? "about:blank"` dead — url is required (:99) | Dead defensive code | Drop ?? or make url optional |
| note | libs/core/src/browser/session.ts:593-603 | hasBlockingOverlay fails open (false on error) | Wedged page reports "no overlay" | Acceptable; comment it |

Clean: storage-state trust — stale/expired auth NOT silently trusted (inspectAuthState refuses missing/malformed/empty/expired at session.ts:253-261 and 575-578; writeValidatedAuthState atomic 0600, refuses to clobber good state with bad). No secrets written to unintended paths.

## Strengths
- Auth-state hygiene: validated-before-persist (atomic tmp+rename, 0600), expiry detection, "only completed logins persist" policy — each path pinned by specs.
- Deliberate credential-leak prevention: accessibleName refuses input `value` (dom-snapshot-builder.ts:282-291, with rationale); custom-login passes creds via env and redacts from errors.
- Clean decomposition with golden parity specs pinning exact selector strings; diagnostics on stderr keep --json stdout clean.
- Robust interaction fallbacks: frame-aware scopes, strict-mode first-visible recovery with warning, selector-memory recording that can never break an action.

## Test-coverage observations
- No test exercises newContext/newPage/onBrowserReady failure in the handoff — the zombie-browser path is uncovered (mocks always succeed).
- loadAuthState tested only for invalid-state rejection; the stranded-context path is uncovered.
- registry.spec aborts with a single lease; forceClose racing concurrent leases untested.
- No escaping tests: htmlName with quotes, backslashes in testId/label/name, digit-leading ids.
- No resolveLocator test with options beyond `{ name }` (exact: true) — the silent name-drop uncovered.
- navigate retry/relaunch untested; reload/goBack/goForward/waitForNavigation/screenshot/saveAuthState/hasBlockingOverlay have no specs.
- custom-login-runner: one happy-path integration test; buildCustomLoginSpec, redactKnownSecrets, ensureAuthSpecCollected untested.
- The reason-race and waitForSelector timeout exhaustion untested.

## Verdict
**needs fixes** — the auth/selector layer's core safeguards are well built, but a reachable zombie-browser leak on the handoff error path, a stranded session after failed auth swap, lease force-close racing concurrent holders, and several selector-escaping gaps strike exactly the two things this layer must never get wrong: lifecycle and selector correctness.
