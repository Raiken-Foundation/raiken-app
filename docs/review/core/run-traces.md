# Core Review — run-traces

**Scope:** `libs/core/src/run-traces/` (4 files, 453 lines — JSONL agent-run trajectory recorder under .raiken/traces/)
**Method:** direct line-by-line read in-session (assigned late; small module). Report-first — no changes made.

## Findings

| Severity | Location | Issue | Why it matters | Fix direction |
|---|---|---|---|---|
| note | libs/core/src/run-traces/recorder.ts:80-95 | forOperational() is ON by default (only RAIKEN_OPS_TRACE=0/false disables) whenever .raiken/ exists — the orchestrator's doc comment (orchestrator/index.ts:70-76) claims "iff RAIKEN_TRACE is set"; mismatch already recorded in chat-workflows-orchestrator.md | Users get .raiken/traces/ JSONL they didn't opt into | Fix the comment or gate the default |
| note | libs/core/src/run-traces/recorder.ts:60-75 | rotateTraceFiles runs on EVERY recorder construction (each operation start): readdir + lstat of up to 200 files per run | Cheap but repeated sync FS work on hot paths | Rotate on a time threshold (e.g. once per hour per project) |
| note | libs/core/src/run-traces/recorder.ts:146-152 | append()/mkdir failures set broken=true and tracing silently stops for the run (by design — traces must never break runs — but nothing surfaces it) | A full disk silently disables diagnostics | One-time console.warn on first break |
| note | libs/core/src/run-traces/recorder.ts:52-55 | Constructor requires projectPath or dir; a caller passing neither hits path.resolve(undefined) TypeError outside the try | Type-directed misuse crashes instead of a clear error | Validate options with a clear message |

Clean: rotation.ts is exemplary bounded retention — 200 files / 50 MiB / 14 days, non-throwing by design, containment-checked deletions, lstat skips symlinks, oldest-first eviction; every recorded event passes redactValue/redactString (tool args, results, notes, labels, errors); end() is idempotent with fsync; correlation snapshot attached to every event.

## Strengths
- Redaction-by-default on every event field, including tool_call args and tool_result payloads — traces are safe to share by construction.
- Retention is bounded on all three axes with defensive deletion (symlink-aware, error-swallowing per file).
- The operational/content trace split (lifecycle always, prompts only under RAIKEN_TRACE) is a good privacy/perf default.

## Test-coverage observations
- rotation.spec exists (per the earlier module count: 3 spec files) covering retention basics; the containment guard (assertContainedTraceDir) and the broken-flag silent degradation appear untested.

## Verdict
**ship-shape** — small, disciplined module; only documentation-consistency and minor hygiene notes.
