# Product plan — Trust fixes + PO-facing board (2026-09)

Grounded in: `eval-projects/dogfood-2026-09/FINDINGS-round3-a11y.md` (hands-on defects),
the audience review (Reader = PO/less-technical · Operator = dev · Specialist = test author),
and the dashboard a11y audit.

**North-star metric:** *time-to-first-caught-regression* for a brand-new user in an empty
repo — target **< 15 minutes**, no docs required. Secondary: a PO can answer "does what we
promised work?" from a shared board, unaided, in under 30 seconds.

**Ordering principle:** trust before surface. A board that can say "covered 40%" on no
evidence is misinformation with a logo — Phases 0–1 are the entry ticket to Phase 2.

---

## Phase 0 — Foundation & hygiene (½ day)

Make `develop` installable and the baseline reproducible. Nothing else matters until this.

| # | Slice | Acceptance |
|---|---|---|
| 0.1 | Commit the missing `@nanonets/graft` lockfile entries (currently uncommitted working-tree fix) | Fresh clone: `pnpm install --frozen-lockfile` succeeds on Node 22 |
| 0.2 | Add `.nvmrc` (`22`) — README already references it; engines already require it | `nvm use` in repo root selects Node 22 |
| 0.3 | Decide the fate of local commit `8d40f00 "cosmetic changes"` (unpublished, by Fogha): push to develop / move to a PR branch / park | No unpublished commits on local `develop` |
| 0.4 | `doctor`: check Node version against `engines` + native-module health (`better-sqlite3` loads) | On Node 24, doctor reports the actual breakage with the fix command |

**Verify:** fresh clone, `pnpm install`, `pnpm run test` green on Node 22; `raiken doctor`
on Node 24 names the problem.

## Phase 1 — Trust: the contract stops lying (2–3 days)

Each slice ships with a regression spec derived from the dogfood repro.

| # | Slice | Fix site | Acceptance |
|---|---|---|---|
| 1.1 | **Accessible names, one implementation.** Extract `labelFor` from `form-extractor.ts` into a shared in-page helper; use it in `verify.ts checkObservable` (adds `<label for>`, wrapping `<label>`, `aria-labelledby`) | `libs/core/src/contract/verify.ts:83-95`, `site-discovery/crawler/form-extractor.ts:22-46` | The round-3 repro (label-for-only form) flips false-violation → verified; mint and verify can no longer drift |
| 1.2 | **Verify the submit label** minted into facts (currently discarded by the `parseObservable` regex) — match via `getByRole("button", { name })`, the pattern `submit-empty` already uses | `verify.ts:50-56` | A fact whose submit button was renamed reports violated, not silent pass |
| 1.3 | **Empty scope never passes.** Empty change-set → whole contract in scope (loudly labelled), and/or refuse exit 0 when 0 facts were checked unless `--allow-empty-scope` | `libs/core/src/contract/impact.ts` (empty-`changed` early return) + CLI exit path | Dogfood repro: non-git project, default `verify` on a broken app → exit 1 with facts in scope |
| 1.4 | **Coverage matcher honesty.** Require overlap on the *observable* (not route/tokens), raise the floor, failure-path facts never satisfy success-path ACs, contradictory observables = no match | coverage matcher (see FINDINGS #2) | `tasks-api` fixture: the 5 API ACs report **uncovered**, not "covered (40%)" |
| 1.5 | **Headings via accessibility tree** — `getByRole("heading", { name, level })` instead of `h1–h4` tag matching | `verify.ts:76-79` | `role="heading"` facts verify; h5/h6 visible to the model |

**Verify:** re-run the FINDINGS-round3 repro script end-to-end — all three headline defects
flip; full suite green; new specs pin each behavior.

## Phase 2 — The PO board: the dashboard's primary reader (3–4 days)

A *projection* of existing `contractView` data — no schema or pipeline changes.

| # | Slice | Acceptance |
|---|---|---|
| 2.1 | **Status projection in core** (pure function + tests): per requirement → `works` / `broken` / `not-checked`, with `sinceWhen` (ledger commit stamps) and ticket ref | Unit-tested; consumes today's data |
| 2.2 | **StatusBoard view = dashboard landing.** One row per requirement in ticket language, grouped by ticket/feature. **Three statuses, no percentages, no facts/mint/observables/Cmd/exit codes** | A PO answers "does what we promised work?" from this screen alone |
| 2.3 | **The broken-row moment:** plain sentence ("submitting the reservation form no longer shows …"), ticket ref, since-when, one **Alert the team** button → configured webhook (reuses `contract watch` plumbing) | Clicking alert posts to the webhook; row history visible |
| 2.4 | **Plain / Technical register toggle** — plain = the board; technical = today's contract view with evidence and commands. Deep-linkable (hash routes exist) | Same data, one truth, linkable rows |
| 2.5 | **A11y fixes from the audit:** palette focus trap + restore + `aria-activedescendant` (D1); drawer Escape + labeled close + dialog semantics (D2); one `<h1>` per screen (D3); skip link (D4) | Keyboard-only pass over board + palette + drawer; axe clean on the board |
| 2.6 | **`contractImport` tRPC procedure** — the API cannot add requirements today; the dashboard dead-ends into the CLI (`Cmd` hint). Add import (file path or pasted ACs) so the operator loop closes on the dashboard | Requirements importable from the board's empty state; no CLI handoff |
| 2.7 | **Sharing (stretch):** read-only board link or static export for stakeholders | URL opens the board without auth friction |

**Verify:** Playwright specs for board states (empty / mixed / broken); keyboard + axe pass;
walkthrough with the `table-crud-a11y` live data; show it to a real PO.

## Phase 3 — Bilingual CLI + alert surfacing (1–2 days)

The CLI stays the operator's instrument; its outputs become forwardable to POs.

| # | Slice | Acceptance |
|---|---|---|
| 3.1 | `verify` / `coverage` output: business sentence first ("2 promises broken"), technical detail below; `--json` / `--format github` unchanged | Snapshot tests; an operator can paste output into Slack as-is |
| 3.2 | `contract watch` graduates: documented alert channel; watcher state surfaced as a board banner | Board shows "watching · last check 3 min ago" |
| 3.3 | `init` / `start` print the handoff: board URL + "share it with the team" | First-run output includes the PO entry point |
| 3.4 | **Interface polish:** `--json` on the read commands that lack it (`status`, `sessions`, `search`); document the exit-code contract (0/1/2/3/4/124/130) in the README — it is the gatekeeper's interface and lives only in code comments today | Every read command scriptable; exit codes documented where CI users look |

## Phase 4 — Docs & onboarding alignment (1 day)

| # | Slice | Acceptance |
|---|---|---|
| 4.1 | Fold `mint` into `capture` (auto-run after discovery data exists) — preferred over documenting it; delete the invisible-load-bearing-step problem | Official next-steps == the actual happy path; 1-command path to a non-hollow contract |
| 4.2 | Remove references to the removed interactive agent and `--skip-auth` | `grep` clean |
| 4.3 | Regenerate README command reference from real `--help`; document the pure-API-project boundary | README commands match the binary |
| 4.4 | First-run leads with the evaluator path (not key-gated `-p`); fix the "OpenRouter" jargon leak in no-key errors | New-user walkthrough never hits a dead end |

## Phase 5 — Backlog (prioritized, not scheduled)

1. Report = contract artifact (PO attaches it to stakeholder updates)
2. Close the interactive gap (`explore` mints nothing) or honestly narrow the promise in-product
3. Stale pending reviews cleared on re-verify; verify and coverage share one matching source
4. `capture` probing 0 pages (observed round 3)
5. Virtualize test lists; self-host fonts (D5/D6)
6. Mine the `sync` / `import --ticket` vein — POs author requirements in their tool, never in raiken

---

## Decisions needed before Phase 0

1. **`8d40f00` fate** — push / PR branch / park? (blocking 0.3)
2. **Fold `mint` vs. document it** (4.1) — folding is the better UX, touches CLI behavior
3. **Phase 2 scope now vs. after Phase 1 demo** — recommended: Phase 1 first, board second;
   the board on top of a lying ledger is worse than no board

## Sequencing summary

```
P0 (½d) → P1 trust (2-3d) → P2 PO board (3-4d) → P3 CLI bilingual (1-2d) → P4 docs (1d)
                └── gate: P2 must not ship before P1
```

Total: ~8–11 focused days to a product a PO can read and an operator can trust.
