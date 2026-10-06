# Product plan v2 — Trust, restructure, and the Reader-first dashboard (2026-09)

Supersedes v1. Grounded in: `eval-projects/dogfood-2026-09/FINDINGS-round3-a11y.md`,
the audience review, the interface inventory, and the design-principles review.

**Status:** Phase 0 shipped (`94791ea` lockfile, `40bcb0d` .nvmrc, `7989175` doctor,
`6424b99` plan updates; Fogha's commit preserved on `feat/contract-short-fact-ids`).

**North-star metric:** *time-to-first-caught-regression* for a new user in an empty repo —
target **< 15 minutes**. Secondary: a PO answers "does what we promised work?" from the
board, unaided, in under 30 seconds.

---

## Design principles (the decision framework)

Every slice below is justified by one of these. If a proposal serves none, it is cut.

1. **Name the primary reader.** Each surface has exactly one primary human. CLI →
   Operator. Dashboard board → Reader (PO/less-technical). Workbench → Operator/Specialist.
2. **Speak the reader's language.** The board's vocabulary is the ticket's vocabulary.
   Author-speak (`mint`, `facts`, `observables`, percentages) stays in the workbench.
3. **One path per job.** Two surfaces must not answer the same question differently
   (verify vs. coverage already violate this — Phase 1 fixes the cause, not a symptom).
4. **Progressive disclosure + the asymmetric rule.** *Design for the Reader and the
   operator will still use it; design for the operator and the Reader never will.*
   Every tie goes to the simpler register. Simple is default; complexity is opt-in.
5. **No claim without evidence.** Optimism in output is misinformation for the audience
   least equipped to doubt it. Empty scope ≠ pass. Weak match ≠ covered.
6. **The reader completes their job or the surface fails.** Craft does not redeem a
   surface its primary reader cannot use.

### Surface verdicts this plan acts on

| Surface | Verdict | Action |
|---|---|---|
| CLI | Serves its reader well | Last-mile polish only (Phase 3); never PO-ified |
| Dashboard | Right vehicle, wrong front door | **Restructure** — board-first IA (Phase 2), not a rebuild |
| Contract core | Right model, dishonest ledger | Trust fixes (Phase 1), gate all Reader surfaces on them |
| explore | Under-delivers ("0 facts minted") | Honest experimental gating until it observes (Phase 4) |
| Testing IDE | Aimed at a human who has an IDE | Demote authoring behind triage (backlog); no rebuild |

---

## Phase 1 — Trust: the contract stops lying (2–3 days) — NEXT

Each slice ships with a regression spec derived from the dogfood repro.

| # | Slice | Fix site | Acceptance |
|---|---|---|---|
| 1.1 | **Accessible names, one implementation.** Extract `labelFor` from `form-extractor.ts` into a shared in-page helper; use it in `verify.ts checkObservable` (adds `<label for>`, wrapping `<label>`, `aria-labelledby`) | `libs/core/src/contract/verify.ts:83-95`, `site-discovery/crawler/form-extractor.ts:22-46` | Round-3 repro (label-for-only form) flips false-violation → verified; mint and verify cannot drift |
| 1.2 | **Verify the submit label** minted into facts (discarded by the `parseObservable` regex today) — `getByRole("button", { name })`, the pattern `submit-empty` already uses | `verify.ts:50-56` | Renamed submit button → violated, not silent pass |
| 1.3 | **Empty scope never passes.** Empty change-set → whole contract in scope (labelled loudly); refuse exit 0 when 0 facts were checked unless `--allow-empty-scope` | `libs/core/src/contract/impact.ts` + CLI exit path | Non-git project, default `verify` on a broken app → exit 1 with facts in scope |
| 1.4 | **Coverage matcher honesty.** Overlap on the *observable* (not route/tokens), raised floor, failure-path facts never satisfy success-path ACs, contradictory observables = no match | coverage matcher | `tasks-api` fixture: the 5 API ACs report **uncovered**, not "covered (40%)" |
| 1.5 | **Headings via accessibility tree** — `getByRole("heading", { name, level })` | `verify.ts:76-79` | `role="heading"` facts verify |

**Gate:** Phase 2 must not merge before 1.3 and 1.4 land (1.1/1.2 may ride in parallel).

## Phase 2 — Dashboard restructure: the board is the front door (3–4 days)

The IA change, explicitly: **board-first, workbench behind it.** Not a rebuild — same
React/tRPC components, restructured navigation plus one new projection view.

| # | Slice | Acceptance |
|---|---|---|
| 2.1 | **Status projection in core** (pure function + tests): per requirement → `works` / `broken` / `not-checked`, with `sinceWhen` (ledger commit stamps) and ticket ref | Unit-tested over today's data; no schema change |
| 2.2 | **StatusBoard = landing view.** `#/` (and legacy hashes) land on the board. Contract / testing / quality views move under `#/workbench/*` behind one "Workbench" rail entry. Nothing is deleted; the front door changes | A PO opening `:7101` sees ticket-language rows and zero jargon; operator reaches the old views in one click |
| 2.3 | **The broken-row moment:** plain sentence ("submitting the reservation form no longer shows …"), ticket ref, since-when, **Alert the team** → configured webhook (reuses `contract watch` plumbing) | Clicking alert posts to the webhook; row history visible |
| 2.4 | **Plain / Technical register toggle** — plain = the board; technical = workbench contract view with evidence and commands. Deep-linkable | Same data, one truth, linkable rows |
| 2.5 | **`contractImport` tRPC procedure** (file path or pasted ACs) — the API cannot add requirements today; the dashboard dead-ends into a CLI command | Requirements importable from the board's empty state |
| 2.6 | **A11y fixes:** palette focus trap + restore + `aria-activedescendant` (D1); drawer Escape + labeled close + dialog semantics (D2); one `<h1>` per screen (D3); skip link (D4) | Keyboard-only pass; axe clean on the board |
| 2.7 | **Sharing (stretch):** read-only board link or static export | URL opens the board without auth friction |

**Board content rules (principle 2 & 5):** three statuses; no percentages; no
facts/mint/observables/Cmd/exit codes; every "broken" row cites its evidence.

## Phase 3 — Bilingual CLI + interface polish (1–2 days)

| # | Slice | Acceptance |
|---|---|---|
| 3.1 | `verify` / `coverage` output: business sentence first ("2 promises broken"), technical detail below; `--json` / `--format github` unchanged | Snapshot tests; operator pastes output into Slack as-is |
| 3.2 | `contract watch` graduates: documented alert channel; watcher state surfaced as a board banner | Board shows "watching · last check 3 min ago" |
| 3.3 | `init` / `start` print the handoff: board URL + "share it with the team" | First-run output includes the PO entry point |
| 3.4 | `--json` on read commands that lack it (`status`, `sessions`, `search`); document the exit-code contract (0/1/2/3/4/124/130) in the README — it is the gatekeeper's interface and lives only in code comments | Every read command scriptable; exit codes documented where CI users look |

## Phase 4 — Honest gating & onboarding alignment (1 day)

| # | Slice | Acceptance |
|---|---|---|
| 4.1 | Fold `mint` into `capture` (auto-run when discovery data exists) | Official next-steps == the actual happy path |
| 4.2 | **Gate `explore` honestly:** labeled experimental in `--help`, CLI output, and dashboard ("plans but does not observe yet") until it mints facts | No user spends motivation on a dead end unawares |
| 4.3 | Remove references to the removed interactive agent and `--skip-auth` | `grep` clean |
| 4.4 | Regenerate README command reference from real `--help`; document the pure-API-project boundary | README matches the binary |
| 4.5 | First-run leads with the evaluator path (not key-gated `-p`); fix the "OpenRouter" jargon leak | New-user walkthrough never hits a dead end |

## Phase 5 — Backlog (prioritized, not scheduled)

1. Report = contract artifact (the PO attach-and-share export)
2. Close the interactive gap (`explore` mints nothing) or narrow the promise in-product
3. Stale pending reviews cleared on re-verify; verify and coverage share one matching source
4. Testing IDE demotion: triage (diff/artifacts/confirm) first, editor behind "Edit", `raiken context`-style handoff to the user's real IDE
5. `capture` probing 0 pages (observed round 3)
6. MCP `contract_verify` — let agents refresh before reading
7. Virtualize test lists; self-host fonts (D5/D6)
8. Mine the `sync` / `import --ticket` vein (POs author requirements in their tool)

---

## Sequencing

```
P0 ✅ → P1 trust (2-3d) → P2 board-first restructure (3-4d) → P3 CLI polish (1-2d) → P4 honest gating (1d)
              └── hard gate: P2 merges only after 1.3 + 1.4 ──┘
```

~8–11 focused days to: an honest ledger, a dashboard whose front door is the PO's board
with the workbench behind it, and a CLI that stays the operator's instrument while
speaking one level of PO.
