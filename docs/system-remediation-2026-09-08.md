# Raiken reliability remediation — 2026-09-08

This implements the concrete defects identified in [the system audit](system-audit-2026-09-08.md). It covers the current working tree, including the changes that were already present when the audit started. Nothing has been committed, published, or deployed.

## What changed

| Audit finding | Implemented behavior | Regression evidence |
| --- | --- | --- |
| S1: distinct tests collapse | Results retain reporter file, browser project, describe path, and test name. Reporter filenames resolve from `config.rootDir` to the application project root. Only repetitions with the same identity merge. | Reporter identity and golden-report tests; explicit-file and whole-suite path replay. |
| S2: indexing escapes project | Indexing entry points check real filesystem containment, including every file passed to incremental reindexing, before initializing state. | Sibling paths, traversal, and symlink tests. |
| S3: reports escape project | Output directories, source reads, and screenshot reads enforce realpath containment. Reports use exclusive temporary writes followed by atomic replacement, so existing output symlinks cannot redirect writes. | Output-directory, attachment, and HTML/Markdown/JSON leaf-symlink regressions. |
| S4: wrong failed-suite counts | Summary counts derive from distinct suite identities and actual statuses. | Multiple failing suites and skipped-suite coverage. |
| S5: incorrect history identity | History uses the normalized spec filename. Because legacy memory stores file/title, statuses in the same run aggregate with failure taking precedence across browser projects and describes. | Real SQLite regression in both result orders, including recovery on a subsequent passing run. |
| S6: local API trusts browser origin | Shared HTTP enforcement validates local Host and allowed Origin. Remote session bootstrap requires an exact route, loopback peer, and local Host. | Fastify request injection covers hostile Host, hostile Origin, LAN peer, legitimate bootstrap, and route-prefix confusion. |
| C1/C3: repair weakens requirements | Graph repair, standalone repair, and editor repair share an AST assertion contract. Changes to expected dependencies, matcher, negation, semantic options, multiplicity, disabled tests, and reviewed execution/provenance bypasses are rejected. Mechanical locator and timeout repairs remain accepted. | 35 assertion-contract cases, plus existing repair suites and the browser replay described below. |
| C2: titles count as coverage | Expected values must occur in compatible, meaningful assertions. Titles, comments, setup constants, absence checks, swallowed assertions, and unreachable helper bodies do not satisfy the expected-value gate. Numeric matching respects token boundaries. | Title/vacuity, polarity, number-boundary, and expected-outcome regressions. |
| C4: failed generation reports success | Generation and provider failures propagate through the agent/orchestrator as typed failures. Missing credentials, cancellation, and busy operations retain error semantics. A requested run without execution cannot return one-shot success. | Provider failure through the real orchestrator with no save/run calls, lease-release regression, and one-shot tests. |
| C5: skipped tests satisfy evals | Flakiness scoring requires actual executions, stable full identities, and passing statuses. Empty selections and skipped scenarios no longer make an evaluation pass. Repeat counts must be positive integers. | Skip-completeness, empty-selection, invalid-repeat tests, and the zero-retry golden gate. |

Generation, exploration, classification, and graph repair now keep source/DOM/history evidence out of the privileged instruction message and preserve conversation roles. A common instruction explicitly treats retrieved evidence as untrusted. Standalone interpretation and repair also receive this policy. Repair instructions preserve requirements instead of optimizing solely for a passing rerun. Generation candidate selection compares the complete quality score consistently.

The quality checks also needed repairs: boundary lint now uses the real fixture directories; generated Stryker/store/report files are excluded from Biome; unit workers are bounded; browser-dependent parity tests run with browser integration; and Nx-backed suites use a visible test reporter. Provider-configuration tests isolate ambient credentials.

## Verification

Used Node 22.22.1 and pnpm 10.15.1. Browser/process/Nx checks ran outside the restricted sandbox. No live model API requests were made. Provider keys were removed from the full-suite runner's environment.

| Check | Result |
| --- | --- |
| `pnpm check` | Passed with no fixes needed. |
| `pnpm lint:boundaries` | Passed. |
| TypeScript, all four projects | Passed; fresh core and CLI checks also passed. |
| Standard `pnpm test` | Core, shared, CLI, and dashboard passed. |
| `pnpm test:trust` after final hardening | 48 deterministic checks passed. |
| Focused assertions/generation/repair/coverage suites after final hardening | 134 tests passed. |
| Browser integration | 47 tests passed, plus the new repair contract browser test passed separately: 48 total. |
| Production CLI and dashboard build | Passed. |
| Built CLI smoke | Version 0.6.3 and live/ready health endpoint passed. |
| Built CLI golden-suite gate | 12 tests × 5 runs = 60 passes, retries disabled, all 12 executed in every run. |

The new `pnpm test:trust` command selects the deterministic adversarial acceptance, prompt-role, and terminal-outcome tests. It is also included in the accuracy CI job, alongside the existing repeated golden suite. These cases are part of the ordinary core unit suite too.

The browser repair regression supplies a fixed model response to the real `executeRepairAttempt` function. It accepts a locator correction, executes the accepted assertion in Chromium against a healthy `$59.00` DOM, verifies the same assertion fails against a mutated `$49.00` DOM, then verifies a response changing the requirement to `$49.00` is rejected. This verifies the acceptance/runtime boundary without claiming model-generation accuracy.

Logs for this remediation are under `/tmp/raiken-remediation-*.log`. They are local verification artifacts, not repository deliverables.

## Limits of this result

- Static assertion analysis is a conservative acceptance check, not a proof of arbitrary JavaScript behavior. Dynamic helpers, custom fixtures, dependency changes, complex control flow, and a locator redirected to the wrong element still need review and behavioral evaluation. Some legitimate structural repairs may be rejected. The explicit standalone `--allow-weaken` override remains available when the user intentionally changes a requirement.
- The prompt tests establish message roles and evidence placement. They do not measure whether a live model resists an injection, writes the right test, or preserves intent across an entire workflow.
- The handwritten golden suite measures execution stability. The model response in the new browser repair check is deterministic. Neither is a live-model benchmark.
- Legacy failure memory deliberately aggregates by file/title. It no longer erases a failure within a run, but does not provide separate historical series for each browser project and describe block.
- Production latency, model cost, accessibility, and behavior across all supported external providers have not been measured in this remediation. The dashboard build still reports a large main JavaScript chunk.

Before making a stronger product-quality claim, run a versioned live-model dataset against healthy and deliberately broken fixtures. Record the provider/model, prompt revision, resolved non-secret configuration, generated artifacts, expected-failure behavior, repeated-trial success, latency, and cost. Include auth, multi-page tasks, injected page text, provider failure, cancellation, and repair preserving app defects. Keep this separate from the deterministic CI gate so missing provider credentials cannot be mistaken for measured model success.
