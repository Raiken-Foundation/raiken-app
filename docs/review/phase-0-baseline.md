# Phase 0 — Environment & Baseline Report

**Date:** 2026-09-18 · **Runner:** DSH agent session · **Mode:** report-first (no source changes)

## Environment

| Item | Value |
|---|---|
| Repo | `/Users/Armand/Documents/Code/raiken/raiken-app`, branch `develop` |
| Node used | v22.22.1 via nvm (matches `.nvmrc`) — **required**, shell default is v24.18.1 |
| Why Node 22 | `better-sqlite3` prebuilt is ABI 127; Node 24 (ABI 137) fails to load it (131 spurious failures per 2025-08-25 audit) |
| Pre-existing dirty files | `.github/workflows/ci.yml`, `.gitignore`, `README.md`, `apps/cli/src/__tests__/help-text.spec.ts` — untouched |

## Results — all green

| Suite | Command | Files | Tests | Result |
|---|---|---|---|---|
| `libs/shared` unit | `pnpm nx run shared:test` | 16 | 70 | ✅ pass |
| `apps/cli` unit | `pnpm nx run cli:test` | 39 | 263 | ✅ pass |
| `apps/dashboard` unit | `pnpm nx run dashboard:test` | 30 | 179 | ✅ pass |
| `libs/core` unit | `pnpm nx run core:test` | 140 | 1480 | ✅ pass |
| Trust suite | `pnpm test:trust` | 4 | 48 | ✅ pass |
| Lint | `pnpm lint` (Biome) | 871 files | — | ✅ clean |
| Typecheck | `pnpm typecheck` | 4 projects | — | ✅ clean |
| Integration | `pnpm test:integration` | 19 | 48 | ✅ pass (Chromium, 130s serialized) |

**Grand total: 248 spec files / 2088 tests executed — 100% pass under Node 22.**
**Unit total: 225 files / 1992 tests, 100% pass under Node 22.** This confirms the audit's
diagnosis: the previously observed 131 failures were purely the Node 24 ABI mismatch —
not test or code defects.

## Notes & observations

1. **File-count reconciliation:** `libs/core/src` contains 159 spec files on disk; the unit
   loop ran 140. The delta is `*.integration.spec.ts` files excluded from the unit config by
   design (serialized into `test:integration`) — layering working as intended.
2. **Simulated failures in output are expected:** 429 Too Many Requests, tokenizer failures,
   and `boom` messages in logs are deterministic failure-fixtures inside passing tests.
3. **`NO_COLOR`/`FORCE_COLOR` warning noise:** every Node process prints the audit's known
   cosmetic warning (§3.5). Candidate for the fix backlog (unset in Nx test targets).
4. **`baseline-browser-mapping` staleness warning** in `config-parity.server.spec.ts` —
   cosmetic, backlog candidate.

## Findings (Phase 0)

| # | Severity | Finding | Where |
|---|---|---|---|
| 0-1 | note | No guard against running tests under the wrong Node (audit rec #2, `precheck-node`) | `package.json` |
| 0-2 | note | `NO_COLOR`/`FORCE_COLOR` conflict warning on every test process | Nx targets / shell env |
| 0-3 | note | `baseline-browser-mapping` data >2 months old | `libs/shared` dev deps |

No blockers, no code defects found at the baseline layer.
