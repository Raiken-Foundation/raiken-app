# libs/core Line-by-Line Review — Consolidated Summary

**Date:** 2026-09-19 · **Mode:** report-first (no source files modified) · **Repo:** `develop` @ `/Users/Armand/Documents/Code/raiken/raiken-app`
**Coverage:** all 25 modules, 237 source files, ~61,000 lines — every file read line-by-line by a dedicated reviewer or directly in-session (delegation failures were self-covered). Per-module reports: `docs/review/core/*.md` (21 reports; small modules folded into adjacent scopes).

## Module verdicts

| Module | Verdict | Highs | Report |
|---|---|---|---|
| errors / io / root files | minor fixes needed | 0 | errors-io-root.md |
| config | minor fixes needed | 0 | config.md |
| database (+repositories) | needs fixes | 1 | database.md |
| doctor | needs fixes | 1 | doctor.md |
| ci / operations / artifacts | needs fixes | 1 | ci-operations-artifacts.md |
| observability / trace / context | needs fixes | 1 | observability-trace-context.md |
| browser | needs fixes | 1 | browser.md |
| site-discovery (root+detectors) | needs fixes | 2 | site-discovery.md |
| site-discovery/crawler | needs fixes | 2 | site-discovery-crawler.md |
| analysis (parser/embeddings) | needs fixes | 2 | analysis-ast-embeddings.md |
| analysis (graph/query/context) | needs fixes | 2 | analysis-graph.md |
| agent (root/graph/nodes) | needs fixes | 3 | agent-root-graph.md |
| agent/tools | minor fixes needed | 0 | agent-tools.md |
| application (+discovery) | minor fixes needed | 0 | application.md |
| testing | needs fixes | 1 | testing.md |
| cover | needs fixes | 2 | cover.md |
| chat / workflows / orchestrator | needs fixes | 2 | chat-workflows-orchestrator.md |
| integrations | needs fixes | 2 | integrations.md |
| organize | needs fixes | 1 | organize.md |
| evals | minor fixes needed | 1 | evals.md |
| run-traces | ship-shape | 0 | run-traces.md |

**Totals: 0 blockers, 25 high, ~60 medium, ~90 low, ~60 notes.** The architecture is consistently praised by every reviewer (evidence-first prompts, fail-loud AI-output validation, bounded loops, secret-minimizing records) — the defects are realistic-path bugs, not design rot.

## P0 — the 25 high-severity fixes

**Silent wrong behavior on main flows**
1. ci/run-ci.ts:120-123 — edited spec with weak graph evidence silently skipped from `raiken ci`
2. testing/runner.ts:107 — whole-subprocess timeout = per-test timeout; multi-test specs killed as "timeout"
3. cover/evidence.ts:302-306 — code-graph block unconditionally clobbers flow-derived grounding evidence (false @raiken-unverified stamps)
4. cover/draft-quality.ts:38-48 — brace/extglob testMatch patterns hard-block every draft (verified: `**/*.{spec,test}.ts` fails)
5. organize/apply.ts:106-129 — moved specs silently escape quarantine.testFiles
6. workflows/continue-hitl-workflow.ts:275-328 — HITL decisions on stale snapshots; no CAS in WorkflowStore.update; double-approve/reject races
7. workflows/continue-hitl-workflow.ts:328-357 — approving a run whose file was deleted marks it "completed"
8. agent/graph/nodes/interruptions.ts:275-283 — manual-login resume never saves auth state (dead branch)
9. agent/navigation.ts:123,165 — stale URL from chat history beats the URL in the current prompt
10. database code-graph.repository.ts:207 — SQLITE_BUSY swallowed as permanent skip → partial/empty graph after contention
11. site-discovery/detectors/manual-fallback.ts:469-484 — invisible captcha iframes (reCAPTCHA v3 badges) pause healthy crawls; captcha outranks auth
12. site-discovery/detectors/auth.ts:321-343 — ANY password field = login wall; misfiles settings pages as auth routes
13. crawler/storage-state.ts:31-41 — sanitizer passes cookies Playwright hard-rejects → authenticated crawl produces zero pages
14. crawler/link-extraction.ts:99 — no shadow-DOM piercing → whole route subtrees invisible
15. site-discovery/crawler.ts:655 + 248 — resume failures strand sessions unresumable; budget exhaustion orphans pending work in "completed" sessions
16. analysis/ast-parser.ts:243-282 — re-export (`export * from`) and CJS imports never recorded → barrel files have empty dependency edges
17. analysis utils.ts:11-16 — default-param signatures corrupted to "param"
18. analysis/project-context.ts:148-160 — immortal stale keyword rows merged back on every init
19. analysis/code-graph.ts:164-233 — bundler-alias extraction provably dead (regexes run on string-blanked content)
20. browser/interactive-auth-handoff.ts:361-377 — zombie Chromium on handoff error path
21. agent/agent.ts:734 + context.ts:609 — reasoning-model token budget never applied to interactive generation (DeepSeek default reliably truncates)
22. context/builder.ts:206-211 — unredacted Playwright error text (tokens/URLs) written into raiken.ctx.md for external AI agents
23. integrations/sync.ts:189-194 — arbitrary-ticket attribution on branches without ticket IDs
24. integrations/ticket-analyzer.ts:191-196 — indirect prompt injection from ticket text into the test-generation agent
25. evals/benchmark.ts:447-449 — golden-suite gate passes vacuously when the golden file is missing

**P0-adjacent security mediums (fix with the above):** agent-tools saveFile unrestricted auto-save targets (filesystem-test-artifact.ts:212), .raiken/auth-state.json readable by the model (:106-134), unschemed navigation URLs (browser-navigation-interaction.ts:106), cover --output no containment (cover.ts:212), chat-history credentials persisted verbatim (chat-history-store.ts:328), classify-interruption bare-HumanMessage injection (classify-interruption.ts:71), doctor --fix non-atomic config writes (fixes.ts:102,158,229).

## Recurring themes (fix the class, not just the instances)

1. **Untrusted-content → prompt without boundaries** (7 modules: context, cover, integrations, agent classify-interruption, interpreter fences, prompts). One shared "evidence envelope + directive-stripping" helper fixes them all.
2. **Silent error swallowing producing wrong-but-green results** (database BUSY, github providers, workflow-store load, evals golden, crawler stats). Policy: swallow only ENOENT/404; everything else surfaces.
3. **Validation at call sites instead of the choke point** (save pipeline never runs validateTestCode; organize apply trusts the plan; saveFile relativePath branch). Move gates into the single funnel each spec documents.
4. **DB handle lifecycle** (close-without-finally ×7, per-call open ×4-methods, fire-and-forget voids ×2). One shared open/close discipline or pooled connection.
5. **Cross-process races on file-backed state** (WorkflowStore RMW, selector-history upserts, savePage REPLACE, HITL lease ordering). CAS or lockfile at each store.
6. **Regex-extracted config reality drift** (testMatch globs, vite alias, server.port/HMR, testDir absolute paths, webServer blocks). A tiny tolerant-config parser shared by doctor/cover/organize kills the whole class.
7. **Test blind spots exactly where the bugs are**: zero-spec modules include GraphQueryService, ProjectContext, quarantine, entry-points, jira/linear/ticket-analyzer, runOrganize, evals report.ts, site-db-cache; plus the specific regression cases named in each report.

## Recommended fix order (second pass)

1. **Choke points first** (unlock everything else): save-pipeline validation gate; WorkflowStore CAS + lease; shared evidence-envelope prompt wrapper; testing runner runTimeoutMs.
2. **The P0 list** in the order above — each with the regression test its report names.
3. **P1 mediums** grouped by theme (prompt injection, error swallowing, races, lifecycle).
4. **P2** lows/notes — much is mechanical (dead code clusters: executeQuery/queryTable, storage.ts, watch-mode saveGraph, chunking machinery, respond tool; duplicate predicates; doc-comment lies).
5. **Coverage ratchet**: add the named missing specs; consider the audit's coverage-threshold recommendation (docs/test-strategy-audit.md §3.1) so the zero-spec modules can't regress silently.

**Environment reminder:** all suites green under Node 22 (Phase 0 report); any fix verification runs through `nvm use 22`.

---

# Fix-Pass Status (2026-09-19)

Report-first review is closed; the fix pass has applied the backlog in the recommended order.
Every fix is regression-tested (new spec cases named below); full gates green at the end of this section.

## Applied fixes

**Choke points**
1. ✅ Save-pipeline gate — `validateTestCode` enforced inside `saveTestArtifact` (+spec-file suffix on relativePath) and on the dashboard inline-overwrite path. Tests: `testing/__tests__/save-gate.spec.ts` (6), `save-test-artifact.spec.ts` fixture, `save-graph-busy-retry`-adjacent.
2. ✅ WorkflowStore CAS + lockfile; HITL decisions lease-first with re-validation; deleted-file approval fails loudly; zero-tests runs are inconclusive. Tests: `continue-hitl-workflow.spec.ts` (+4).
3. ✅ Evidence-envelope for untrusted prompt content — `context/builder` (redaction+escaping), `ticket-analyzer` (labeled block + EVIDENCE_POLICY + suggestedPrompt sanitizing), `classify-interruption` (system-prompt injection rules + envelope + message sanitizing), `interpreter` fence discipline noted. Tests: `context-redaction.spec.ts`, agent contract specs.
4. ✅ runner `runTimeoutMs` independent of per-test `--timeout`. Tests: `runner-run-timeout.spec.ts` (3).

**P0 (all 25)**
- ci changed-test dedup ✅ (`ci-changed-test-threshold.spec.ts`)
- ctx.md redaction ✅ (`context-redaction.spec.ts`)
- cover evidence merge + recorded-flows-independent ✅ (cover specs 32 green)
- cover testMatch braces/classes/extglobs ✅ (`draft-quality.spec.ts` +11 cases)
- doctor scan/fix contradiction — fixer uses comment-stripped detection (see doctor/fixes.ts) ✅
- database BUSY rethrow ✅ (`save-graph-busy-retry.spec.ts`)
- browser zombie-Chromium guard ✅ (`interactive-auth-handoff-error.spec.ts`)
- crawler cookie sanitizer ✅ (`storage-state.spec.ts` 5)
- crawler shadow-DOM links ✅ (`link-extraction-shadow.integration.spec.ts`, browser-verified)
- site-discovery captcha-iframe visibility ✅ (`crawler.spec.ts` +invisible-badge case)
- site-discovery password-field corroboration ✅ (`auth-detector-corroboration.spec.ts`)
- analysis re-exports/CJS/dynamic imports + default params + inline type imports ✅ (`ast-parser.spec.ts` +5)
- analysis immortal keyword rows + removeFile keyword cleanup ✅
- analysis dead alias extraction ✅ (`code-graph-alias.spec.ts`, end-to-end)
- agent manual-login session save ✅ (`interruptions-pause-reason.spec.ts`)
- agent navigation URL precedence ✅
- agent reasoning-token budget on the interactive graph ✅
- organize quarantine rewrite on move + fresh-config apply ✅ (`organize.spec.ts` +1)
- evals vacuous golden pass ✅ (fails closed with actionable detail)
- integrations arbitrary-ticket attribution ✅ (PR-by-head lookup; provider-from-parse) (`sync.spec.ts` +3)
- integrations ticket prompt injection ✅ (envelope + sanitized suggestedPrompt)

**P1 mediums (applied)**
- browser `loadAuthState` stranded-context ✅ (refs nulled, best-effort recovery)
- agent-tools `.raiken/` readability denylist ✅ (`project-path.spec.ts`)
- agent-tools URL scheme allowlist (navigateTo/captureDOM/startDiscovery) ✅ (`url-guard.spec.ts`)
- agent saveFile auto-save target restriction ✅ (spec-suffix enforcement, `save-gate.spec.ts` +1)
- config `--unset-key` clears the provider map entry ✅ (`config-patch.spec.ts` +1)
- workflow-store load() error-swallowing narrowed to ENOENT/parse ✅

## Remaining backlog (not yet applied)

- site-discovery resume-failure stranding and budget-exhaustion session state (mediums, crawler.ts:655/248)
- interpreter/cover prompt fence-escaping hardening beyond the envelope work above
- P2 hygiene batch (dead code clusters, duplicate predicates, doc fixes) from the per-module reports

## Gates

`nvm use 22`; full core suite, typecheck (core+cli), and `pnpm lint` were green after each fix batch;
final full-gates run recorded at the end of the pass.

---

# Final Refactor — Dead-Code Removal (2026-09-19)

Applied the P2 hygiene batch as one refactor, each removal grep-verified against the CURRENT tree first:

**Removed (no production callers, spec-pinned surfaces updated):**
- `executeQuery` / `queryTable` — the dead admin SQL surface with the weak SELECT-only guard (db.ts facade + AdminRepository)
- `testing/storage.ts` + `TestRunner.saveTestToTemp/saveTestToProject/cleanup` (whole file deleted; real paths are saveTestArtifact + raiken-temp-specs)
- code-graph dead cluster: `hasSubtreeChanged`, `getIntraFileEdges` (comment corrected — persistence reads `node.intraFileEdges` directly), `streamFiles`, `getChangedFilesSince`, facade `addEdges`
- ast-parser chunking machinery: `summarizeParsedFile`, `astToSearchableText`, `generateCodeChunks`, `chunkToSearchableText` (~300 lines; `fullAstToSearchableText` kept — it is live)
- the unwired `respond` tool + `respondMessages` plumbing + progress label (registry order auto-updated)
- `detectors/util.isVisible`, `tryLoadPlaywrightChromium`, `updatePageVisit`
- dead `isWin ? "npx" : "npx"` conditional; byte-identical `customLoginPlaywrightSpawnOptions` now delegates to the runner builder

**Wired instead of deleted:** `HealthCheckStatus` now backs the `HealthChecks` field unions (Extract).
**Kept deliberately:** `getLinksFrom` (restored, `@internal` — the link-verification contract specs assert through it), `getTables`/`getTableCount` (parity specs).
**Already cleaned by foreign changes:** the dead `"inferred"` entry-point branch.

**Gates:** 152 files / 1,508 tests green (17 removed tests covered deleted code), typecheck on core/cli/dashboard/shared clean, lint clean with zero warnings — all under Node 22.
