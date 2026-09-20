# Raiken QA Session Prompt

Paste this entire document to an agent at the start of every QA session. It is
the complete protocol for testing **Raiken**. Follow it top-to-bottom; do not
skip phases.

**The feedback loop (why this exists):** every test session surfaces a new
problem. After a session's verdict is validated by the human, *append* any new
defect to §8 and any new idea to §9 so the next session re-checks them. This is
how the system gets more robust over time — each bug found once is guarded
against forever after.

**The prime directive:** the aim is to **find bugs**, not to confirm the system
works. A feature that "works" is only half the test — actively try to break it.
Never let a green run become a rubber stamp. If you only ever test against
correct apps, you are validating Raiken's behavior, not testing it.

---

## Role

You are a QA engineer testing **Raiken** — a local, AI-powered CLI that
generates, runs, and repairs Playwright end-to-end tests. Use the product like
a real developer would. Be adversarial: assume things are broken until you've
seen them work, and assume a passing test might be a *false* pass (the test
adapted to a bug instead of catching it). At the end, deliver a written verdict.

## Prerequisites (verify before testing)

```bash
node --version        # must be v22.x (use ~/.nvm/versions/node/v22.22.1/bin)
pnpm --version        # v10.x
pnpm run cli:build    # build first — never test a stale binary
node dist/apps/cli/bin.cjs --version
```

- CLI binary under test is `dist/apps/cli/bin.cjs`.
- AI features need a key (repo root `.env` / env vars). **Cost-aware**: run at
  least one `cover` and one `repair`, but don't over-spend.

## Sandbox quirks (important — read once)

- **Crawlee-backed commands need full access.** `raiken discover`,
  `raiken eval playground`, and `raiken eval benchmark` spawn `/bin/ps`, which
  the workspace-write sandbox blocks (EPERM). Escalate *only those* commands to
  `danger-full-access`. Everything else runs sandbox-safe.

---

## Phase 1 — Baseline (the testing scripts)

Run in order; record pass/fail for each:

```bash
pnpm run typecheck
pnpm test                 # unit suites: core, shared, cli, dashboard
pnpm lint
pnpm run cli:build        # full build (includes install-deps — must succeed)
pnpm smoke:cli            # built-artifact smoke (version + health endpoint)
```

Then the deterministic eval harnesses (from the repo root):

```bash
raiken eval playground --json          # needs full access
raiken eval benchmark --json           # needs full access
# golden auth suite ×3, retries disabled (from tools/playground-tasks):
raiken eval flakiness tests/auth-flow.spec.ts --runs 3 --expect-tests 12
```

Judge: any `--json` output must be **pure JSON on stdout** (no stray log lines).

---

## Phase 2 — Command surface (deterministic, no LLM)

Exercise each command and verify the **exit-code contract**:
`0` success · `1` runtime/test failure · `2` usage error · `3` config/auth error
· `4` busy · `130` cancelled.

```bash
raiken --version                       # → 0
raiken --help                          # → 0, grouped help
raiken init -y                         # in a fresh scratch dir
raiken config --list --json            # → 0, provider catalog + current config
raiken status --json                   # → 0
raiken doctor                          # → 0, clean
raiken index                           # → 0, builds code graph
raiken search "<query>"                # → 0, semantic results
raiken test --list                     # → 0, lists specs
raiken test <spec> --json              # run a known-good spec
raiken report <spec> --format html,json --output test-reports/qa
raiken ci --skip-run --json
raiken trace "<stack trace>"
raiken context --json
raiken memory show --json
raiken sessions --json
raiken hooks status

# negative paths (must return the documented exit codes):
raiken boguscommand        # → exit 2 + did-you-mean suggestion
raiken eval nosuchsuite    # → exit 2
raiken eval flakiness      # → exit 2 (missing required target)
raiken start -p notaport   # → exit 2 (invalid port)
```

---

## Phase 3 — Fresh one-off projects (real-world validation)

Every session, build **1–3 new, genuinely complex apps** under `tmp/`
(gitignored). **Never reuse a prior session's app** — the whole point is a novel
target each time.

Each app must exercise at least **three** of these real-world axes:

1. **Async loading** — data that arrives after a delay (`setTimeout`/`fetch`),
   with a visible "loading" state first.
2. **Debounced search** — a search input whose results update after a debounce.
3. **Multi-step form/dialog** — a wizard with per-step validation.
4. **Dynamic/opaque IDs** — server-generated ids the test can't predict.
5. **Auth/roles** — a login wall with at least two roles, or a gated action.
6. **Pagination** — a "load more" / paged list.

For each app:

```bash
cd tmp/<app>
raiken init -y
raiken index
raiken discover http://127.0.0.1:<port>   # full access
raiken cover "<complex scenario>"          # inspect the draft + grounding flags
raiken test <draft>.spec.ts               # run it (--allow-unverified if stamped)
```

Record, honestly, per scenario: **did the draft run? did it pass? what was
stubbed as TODO / flagged `@raiken-unverified`, and why?** A passing simple
scenario is a data point; a stubbed complex one is a finding — both matter.

---

## Phase 4 — Bad-app test (the bug-catching gate)

This is the single most important test. The question is **not** "can Raiken
generate a passing test?" but **"does Raiken catch a bug, or does it adapt to
one?"**

Build one **deliberately-buggy** app (or use `tools/playground-store-buggy`) with
a *known* incorrect behavior — e.g. a search box that ignores the query, a price
that is $10 off, a "delete" button that does nothing.

Then:

1. `raiken cover "<scenario naming the CORRECT behavior>"` — the draft must
   assert the *intended* behavior, not the bug.
2. Run it against the buggy app → **it MUST FAIL**. That failure is the
   success: the generated test caught the bug.
3. `raiken repair` on that failure → **it must NOT weaken the assertion to
   match the buggy app.** That would be a false green (the test adapting to the
   bug instead of catching it). It should keep the correct assertion and report
   the app-side issue.

Record: **did the draft catch the bug? did repair preserve the correct
assertion?** If repair "greens" the buggy app by changing the expectation, that
is a DEFECT in Raiken — report it as the top finding.

---

## Phase 5 — Repair

Test repair on a **deliberate selector failure**, separate from the bad-app test:

```bash
# write a spec with a WRONG selector (e.g. getByTestId("does-not-exist"))
raiken test e2e/repair-probe.spec.ts --json   # confirm it FAILS
raiken repair e2e/repair-probe.spec.ts --apply --json
cat e2e/repair-probe.spec.ts                  # check the fix is real
```

Judge: does it fix the selector, verify green, and (on a *good* model) converge
in ≤3 attempts? Does it revert honestly when it can't fix? Is the `--json`
output self-consistent (see §8)?

---

## Phase 6 — Dashboard / server

```bash
raiken start -p <port>
curl http://127.0.0.1:<port>/api/trpc/getHealth
curl http://127.0.0.1:<port>/api/trpc/getProjectInfo
curl http://127.0.0.1:<port>/api/trpc/getConfig
curl http://127.0.0.1:<port>/api/trpc/listAIProviders
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<port>/   # → 200 HTML
```

---

## Phase 7 — Verdict

Deliver a written verdict in this fixed shape:

1. **What works** (with the evidence you observed, not assumptions).
2. **Defects found** (ranked by severity, with `file:line` where you can).
3. **Bug-catching honesty** — did the bad-app test show Raiken catches bugs, or
   does it adapt to them? This is the headline judgment.
4. **Real-world readiness** — the "simple vs. complex" gap, stated honestly.
5. **Comparison** to other AI testing tools.
6. **Top 3 recommendations** in priority order.

---

## Phase 8 — Known issues (regression checklist)

Re-check **every** item below each session, and report whether it still holds
(regressed) or is fixed. Keep the two lists updated (see §11).

### Fixed — must NOT regress

1. **`cover` must not inject `storageState` into login-flow scenarios.** A
   "log in as X" / "MFA" / "invalid credentials" prompt must produce a draft
   *without* `test.use({ storageState })`.
2. **Blocking TODO stubs must be reported honestly.** A draft with commented-out
   steps must say "N step(s) stubbed as TODO" (not "optional … not blocking").
3. **React selectors must be source-grounded.** After `raiken index`, a
   `getByTestId("…")` whose `data-testid` is in a `.tsx` file must be
   `sourceGrounded`, not `unverified`.
4. **"login" as data must not read as auth.** "search for 'login'" must NOT
   trigger the "signed-out app" auth warning.
5. **Non-unique `data-testid`s must be scoped.** cover should scope repeated
   test ids or use a unique `getByRole(name)` instead of a bare shared id.
6. **Async content must be captured.** With `settleQuietMs`/`settleMaxMs`
   (default 400/3000), discovery captures loaded content, not "Loading…".
7. **Invented assertion values must be flagged.** `toHaveText('$5.90')` with no
   captured/scenario/typed evidence must produce an `unknown_value` warning.
8. **`--json` stdout must be clean.** No `console.log` leaks. Verify by
   `JSON.parse`-ing the output.
9. **`cli:build` / `install-deps` must succeed.** `sharp` is overridden to
   `^0.33.5`; a clean-room install must not fall back to a source build.
10. **DeepSeek models must be listed at the root.** `listProviderModels` for
    `deepseek` must hit `https://api.deepseek.com/models` (not `/v1/models`).
11. **Repair must never weaken an asserted value.** Standalone `raiken repair`
    now carries a deterministic assertion-value guard (plus an unconditional
    prompt rule) that rejects any fix changing a `toHaveText`/`toEqual`/… value;
    `--allow-weaken` is the explicit opt-out.
12. **`repair --json` truth.** `repaired: true` is emitted only on the
    verified-green path; revert/unchanged emit `repaired: false`.
13. **`raiken ci` scopes to the project.** `git diff` now passes `--relative -- .`
    so a nested project reports its own diff, not the parent repo's.
14. **`deepseek-v4-flash` is marked reasoning.** Reasoning models get an 8000-token
    budget floor and a 32k escalation loop in `callWithTokenBudget`.
15. **No committed API key.** `doctor` flags `api-key-in-config`; the fixture key
    was removed (revoke the leaked key at the provider — still pending).
16. **`cover` grounds client-side routes.** React Router `<Route path>` strings are
    indexed and injected into the cover prompt (`ROUTES DEFINED IN SOURCE`).

### Open — verify and report

1. **Repair is model-dependent.** On a weak model (e.g. `deepseek-chat`),
   repair returns the spec "unchanged" even when the exact fix is in the failure
   output. *(Mitigated — repair now receives the full indexed selector
   inventory, but the outcome still depends on the model.)*
2. **`raiken init -y` may misdetect the package manager** (reports "npm" for a
   pnpm project). *(Not reproduced — `init` correctly scaffolded a pnpm
   project.)*
3. **`cover` still guesses slugs for dynamic routes.** Routes are now grounded
   (`/product/:slug`), but the mapping from an entity to its `:slug` literal
   (e.g. `pulse-mouse` from seed data) is not yet extracted from source.

---

## Phase 9 — Recommendations (rolling)

Accumulated improvement ideas, most-important first. Re-check each session and
add new ones; move one to §8 when it becomes a concrete defect.

1. **Discovery has no "wrong-app" guard.** Crawling the wrong URL silently
   pollutes site knowledge with unrelated pages (observed: a port mixup made
   discovery capture a different app's content, and cover drafted against it).
   Consider asserting the page origin/title matches the target before committing.
2. **Repair should warn on a weak configured model.** Use the existing
   capability metadata to surface "your configured model is weak for repair"
   instead of silently returning the spec unchanged.
3. **Make the "unchanged" repair escalation directive.** When the failure output
   already contains the exact fix (`aka getByRole(…)`), hand that specific
   substitution to the model rather than a generic "never respond unchanged".
4. **Grounding should flag non-unique `data-testid`s** (a shared id repeated
   across rows/cards) so the generator scopes them, rather than relying on a
   prompt nudge alone.
5. **`raiken ci` should scope to the subproject** in a monorepo (it currently
   analyzes the whole repo's diff).
6. **Route the assertion-preservation guard into standalone `repair`.** Extract
   the scenario from the draft's own test name/assertions (or add `--scenario`)
   so `raiken repair <file>` refuses to weaken a stated expectation the way it
   does under `cover --verify`.
7. **Mark `deepseek-v4-flash` as a reasoning model** (or auto-detect from the
   API's `reasoning_content`) so it gets the reasoning timeout/token budget
   instead of aborting.
8. **Treat `raiken.config.json` `apiKey` as a secret.** Git-ignore it and
   warn when a key is found committed (the buggy fixture currently ships a live
   key).
9. **`cover` should ground routes and slugs from the code graph** (route
   definitions and slug literals are already indexed) instead of guessing them.

---

## Phase 10 — Cleanup (only after the human validates the verdict)

1. Delete the session's `tmp/<app>` projects.
2. Remove generated artifacts: fixture `.raiken/`, `e2e/generated/`,
   `tests/generated/`, `test-reports/`, `test-results/`, `playwright-report/`.
3. Confirm `git status` shows no test artifacts.

---

## Phase 11 — Post-session update (the feedback loop)

After the human validates the verdict:

1. **Move** any item from "Open" (§8) that was fixed into "Fixed" (or delete it).
2. **Add** every new defect found this session to "Open" (§8), with a one-line
   repro so the next agent can check it.
3. **Add** every new improvement idea to "Recommendations" (§9).
4. Do **not** change any other section unless it genuinely improves the protocol.
