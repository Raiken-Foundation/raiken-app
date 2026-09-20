# Core Review — ci / operations / artifacts

**Scope:** `libs/core/src/ci/` (5 files, ~813 lines) · `operations/` (2 files, 71 lines) · `artifacts/` (15 lines; artifact service findings live in errors-io-root.md)
**Method:** direct line-by-line read (agent delegation failed twice; reviewed in-session). Report-first — no changes made.

## Findings

| Severity | Location | Issue | Why it matters | Fix direction |
|---|---|---|---|---|
| high | libs/core/src/ci/run-ci.ts:120-123 | Directly-changed test entries are skipped when the evidence map has ANY row for that file (`byTestFile.has`), even when its confidence fell BELOW threshold and was pushed to skippedBelowThreshold (110-113) | An edited spec with weak graph evidence (<0.5) appears in neither affectedTests nor the run — `raiken ci` silently runs NOTHING for a test the developer just changed. The has() check should guard against duplicates in affectedTests, not against evidence existence | Track accepted testFiles in a Set and check that; or fold changed-test entries in BEFORE the threshold pass so their confidence 1.0 wins |
| low | libs/core/src/ci/git-diff.ts:133-149, 165-181 | Unmerged "U" status lines are silently skipped (mapStatus → null) | `raiken ci --staged` on a conflicted index under-reports changed files with no warning | Map U → modified, or emit a conflict warning |
| low | libs/core/src/ci/junit-reporter.ts:99-107 | xmlAttr escapes & < > " and newlines but not invalid XML control chars (0x00-0x08) | A test name carrying control chars produces XML some parsers reject | Strip/replace control characters |
| low | libs/core/src/ci/git-diff.ts:157-181 | getStagedFiles duplicates getChangedFiles' name-status parsing | Divergence risk on future edits | Extract a shared parser |
| note | libs/core/src/ci/git-diff.ts:27 | Shell-string git invocation with manual quote() (correct today, incl. single-quote escaping) | execFileSync with an args array removes the quoting burden entirely | Migrate to execFileSync |
| note | libs/core/src/ci/run-ci.ts:260-261 | `format === undefined → both` duplicates the earlier `?? "both"` default | Redundant | Simplify |
| note | libs/core/src/ci/run-ci.ts:257-276 | Report writes are plain writeFileSync (not atomic) | Reports, not state — acceptable | — |
| note | libs/core/src/operations/project-operation.ts:23-51 | AbortSignal checked only pre-acquire; abort during the operation never releases the lease | A cancelled op holds OPERATION_BUSY until the 45s stale timeout | Wire signal → release |
| note | libs/core/src/operations/project-operation.ts:44 | Manifest survives a crash (read only for error text) | Cosmetic | Clean manifest on stale lock reclaim |

Clean: exit-code contract (0/1 from summary; GitError → CLI's infra path), three-dot diff with rename detection and `--relative` project scoping, CDATA `]]>` splitting in JUnit bodies, flaky→failure JUnit policy (documented — a test that passes only sometimes must block CI), defaultBaseRef GITHUB_BASE_REF handling, ELOCKED → OPERATION_BUSY with holder identification.

## Strengths
- The "changed test file is affected by definition" contract is real, exported pure (`directlyChangedTestEntries`), and documented with the bug it fixed — it just has the threshold-interaction hole above.
- `--staged` synthesizes a stable refs shape so pre-commit reports match CI reports.
- JUnit reporter is minimal and widely-compatible with deliberate, commented policy choices (flaky=failure, skipped counts).
- HTML/Markdown report generation is best-effort AFTER machine-readable outputs, with the failure path warned, not fatal.
- Operation lease: proper-lockfile with stale/update tuning, holder identification in the conflict message.

## Test-coverage observations
- No spec anywhere in libs/core references `directlyChangedTestEntries` or `skippedBelowThreshold` (grep) — the pure export the comment calls "unit-testable" has no unit test, and the high finding's threshold interaction is untested. Check apps/cli ci command specs; add the regression case wherever it lives.
- No test for unmerged-status diffs, control-char names in JUnit, or staged-vs-range parsing parity.

## Verdict
**needs fixes** — one high-severity selection bug (edited spec below confidence threshold silently skipped); the rest is hygiene.
