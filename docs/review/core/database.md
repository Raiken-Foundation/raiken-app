# Core Review — database

**Scope:** `libs/core/src/database/` (16 files, ~3,740 lines: connection, adapter, constants, errors, db.ts facade, schema/schema-manager, embeddings generator, utils, repositories/ ×6)
**Method:** hybrid — foundation files (connection/adapter/constants/errors/schema-manager/db.ts/admin.repository/embeddings/utils, ~1,600 ln) reviewed directly line-by-line in-session after two agent failures; the five repositories (~2,120 ln) reviewed by a delegated agent that also traced cross-module consumers (context/builder, agent/memory, project-context). Report-first — no changes made.

## Findings

| Severity | Location | Issue | Why it matters | Fix direction |
|---|---|---|---|---|
| high | libs/core/src/database/repositories/code-graph.repository.ts:207 | saveGraph's per-file catch swallows SQLITE_BUSY as a permanent "skipped file"; in scan mode clearProject (:92) already wiped the old graph, so a transient lock >5s (concurrent CLI scan + watcher — both supported, parity spec opens two connections) commits a partial/empty graph with misleading skip reasons; runWithRetry's BUSY retry never fires for statements inside the loop | Realistic data-loss path: a lock contention window during indexing silently discards the graph | Rethrow SQLITE_BUSY from the per-file catch so runWithRetry retries the transaction |
| medium | libs/core/src/database/repositories/test-outcomes.repository.ts:145 | getRecentFailures filters status IN ('failed','error') — drops 'timeout' rows | Feeds `raiken context` + repair prompts (context/builder.ts:185, agent/memory.ts:668); E2E timeouts are common and never enter failure memory | Include 'timeout' |
| medium | libs/core/src/database/repositories/code-graph.repository.ts:452-456 | loadGraph SELECT * on files and JSON.parses every parsed_ast AND full AST blob into one in-memory Map | Memory blowout on large repos — the exact thing streamFiles exists to avoid; node.ast parsed even for callers that never use it | Stream or lazy-parse AST columns |
| medium | libs/core/src/database/repositories/code-graph.repository.ts:370-385 | removeFile (watcher path) deletes files/deps/symbols/edges but NOT keyword_index rows — clearProject:705-707 cleans them with a comment describing exactly this failure mode | Stale keyword-search entries after any watched delete | Delete keyword_index rows for the file |
| medium | libs/core/src/database/repositories/memory.repository.ts:60-93, 109-141 | recordSelectorSuccess/Failure do SELECT-then-UPDATE/INSERT with no transaction and NO unique index on (project_path, element_description, selector) | Duplicate rows under concurrent connections; counts split; getBestSelector biased | Unique index + INSERT … ON CONFLICT upsert |
| medium | libs/core/src/database/repositories/code-graph.repository.ts:149-214 | No per-file savepoint: a throw after insertFile.run (e.g. symbol constraint violation) leaves the file row + partial deps committed while the file is reported skipped and excluded from stats | files table and stats diverge until next scan | SAVEPOINT per file inside the transaction |
| medium | libs/core/src/database/connection.ts:91-105 | ensureGitignore no-ops when .gitignore does not exist — and .raiken/ holds auth-state.json (session cookies) and traces | Fresh project without .gitignore: nothing stops session cookies from being committed | Create .gitignore when absent (or warn loudly in doctor) |
| low | libs/core/src/database/constants.ts:1 vs schema/schema-manager.ts:194-197 | SCHEMA_VERSION=6 but migrations run to user_version=7; stats.schema_version and getInfo() report 6. Verified INERT: zero readers of stats.schema_version and no callers of getInfo() today | A v7 DB self-reports v6 — latent trap for any future staleness/downgrade check and misleading when debugging | Derive version from PRAGMA user_version or bump the constant to 7 |
| low | libs/core/src/database/repositories/admin.repository.ts:67-79 (+ db.ts:141-147) | executeQuery/queryTable have ZERO production callers (grep-verified; specs only); the SELECT-only guard is trivially weak (prefix check) | Latent arbitrary-DB-read primitive if ever wired to an endpoint | Delete the dead admin surface or harden behind an explicit allowlist |
| low | libs/core/src/database/connection.ts:68-75 | Corrupt-DB recovery renames only the main DB file — not the -wal/-shm siblings | A stale WAL next to the fresh DB can confuse recovery | Move/remove -wal/-shm alongside the rename |
| low | libs/core/src/database/adapter.ts:23-26 | Busy-retry spin-waits a full RETRY_DELAY_MS at 100% CPU (better-sqlite3 is synchronous) | Burns CPU during contention windows | Atomics.wait-based sleep or rely on busy_timeout alone |
| low | repository-layer lows (agent-verified) | memory.repository getBestSelector can return a never-succeeded selector; getEmbeddingsCount not project-scoped; getTestOutcome lacks project filter; prune subqueries missing id tiebreakers (test-outcomes:463, memory:242); files.last_modified is a dead column; upsertFile:272 lacks saveGraph's serialization guard; latent watch-mode saveGraph path (stale symbols/edges not purged — no current caller); serialization-fallback counts mismatch (:139-146 vs :159-163); substring import-type heuristic (:174); normalizeTestFileKey case-sensitivity | Assorted correctness/hygiene issues, none individually urgent | See locations; batch into the fix backlog |
| note | libs/core/src/database/schema/schema-manager.ts:573-578 | vec0 virtual table fixed at float[384]; CREATE IF NOT EXISTS won't migrate if the embeddings model ever changes dimension | Silent mismatch on a future model change | Version the dimension with the schema |
| note | libs/core/src/database/embeddings.ts:38-55 | initialize() has no concurrency guard — two concurrent first calls double-load the pipeline | Wasteful, not corrupting | Cache the init promise |
| note | libs/core/src/database/embeddings.ts:105 | text.slice(0, 2000) can split a surrogate pair mid-string | Tokenizer edge case; batch isolation catches it | Truncate at code-point boundary |
| note | libs/core/src/database/schema/schema-manager.ts:166-198 | setUserVersion happens AFTER each migration transaction (not inside) — crash between = migration re-runs; verified safe today because every migration is idempotent (IF NOT EXISTS / guarded table drops) | Correctness rests on each future migration staying idempotent — worth a comment stating the invariant | Set version inside the same transaction |

Clean categories: **SQL injection — clean** (every statement parameterized; only interpolated fragments are the whitelisted "="/LIKE operator and generated ?-placeholder lists: symbols.repository.ts:111-121, 186, 266, 275; embeddings.repository.ts:119). **JSON corruption — clean** (safeJsonArray/safeJsonObject on symbols reads; try/catch fallbacks in loadGraph:461-478).

## Strengths
- Multi-process hygiene up front: WAL + busy_timeout 5000 + foreign_keys ON on every open; corrupt-DB detection backs up the broken file and explains recovery in the error message.
- Migration design is genuinely careful: v6's auth_blockers → discovery_blockers copy preserves ids and maps resolution fields; each migration transactional and idempotent.
- Embeddings layer: LRU cache + in-flight dedup + per-item batch isolation via Promise.allSettled with index-aligned nulls (documented rationale).
- test_file keys normalized to posix (normalizeTestFileKey) — the discipline trace.ts lacks.
- Repository decomposition with a thin facade; parameterized statements throughout.

## Test-coverage observations
- No spec covers the saveGraph BUSY-swallow path (skippedFiles with contention) — the high finding.
- removeFile side-table cleanup (keyword_index staleness) untested.
- getRecentFailures timeout-exclusion untested.
- Corrupt-JSON fallbacks in loadGraph, renameTestRecords collision path, prune methods, files.id stability across re-scan, embedding-survives-unchanged-reindex hash gate — all uncovered.
- Parity spec asserts user_version=7 but nothing pins SCHEMA_VERSION to it (the drift would be caught by a one-line equality test).

## Verdict
**needs fixes** — no always-on corruption, but the BUSY swallow is a realistic silent-graph-loss path; selector-history races and the timeout-blind failure memory degrade the learning loop; the rest is hygiene plus one inert-but-misleading version drift.
