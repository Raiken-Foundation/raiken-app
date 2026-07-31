# Immediate Work

This file answers one question:

> What should we build next so Raiken becomes more reliable for beta users?

The work below is ordered. Do not start with the most exciting future feature.
Start with the pieces that make every later feature safer.

## 1. Make Database Changes Safe

Raiken stores its memory in `.raiken/raiken.db`. That database is already useful:
it holds graph data, discovery data, ticket context, and test history.

The problem is that the next features need new tables. If schema changes are not
boring and repeatable, every beta upgrade becomes risky.

Build next:

- A migration registry with ordered migration IDs.
- A table that records applied migrations.
- Tests for fresh databases.
- Tests for old databases upgraded into the new schema.
- A short contributor note explaining how to add the next migration.

This should happen before persistent chat or acceptance-criteria storage.

## 2. Persist Chat History

The dashboard chat works, but it is too session-shaped. If the server restarts,
the conversation context is not durable enough.

This makes the product feel unfinished because test generation is rarely a
single-message workflow. The user asks, Raiken drafts, the user clarifies,
Raiken edits, then the work continues later.

Build next:

- `conversations` table.
- `messages` table.
- Message metadata for generated files, tool summaries, and HITL checkpoints.
- Dashboard history restore.
- A small cleanup/export story before the data grows.

This is the first feature that will make Raiken feel like it has memory at the
user level, not only at the project-analysis level.

## 3. Harden CLI Packaging

The focused `core` and `dashboard` builds pass. The full workspace build has
previously hung during the CLI packaging path, around the dashboard copy and
dependency install steps.

That is a release risk. A beta package must be boring to build.

Build next:

- Reproduce `nx build cli` on a clean checkout.
- Inspect the `install-deps` step in `apps/cli/project.json`.
- Make dependency installation deterministic.
- Add a tarball smoke test:

```bash
npm install -g ./raiken-version.tgz
raiken --version
raiken --help
```

Do this before sending a wider beta.

## 4. Turn Tickets Into Acceptance Criteria

Ticket sync exists. Raiken can read GitHub, Jira, and Linear context from the
current branch or an explicit ticket reference.

The missing layer is structure. A ticket is not just text. It usually contains
acceptance criteria: the behaviors that must be true before the work is done.

Build next:

- `ticket_acceptance_criteria` table.
- Lenient AC extraction for checklists, Given/When/Then, and free text.
- Provenance on each AC: structured, inferred, or manually edited.
- Re-extraction when a ticket changes.

Once this exists, tickets can become testable product intent.

## 5. Link Tests To Acceptance Criteria

After ACs exist, Raiken needs to answer:

> Which tests prove this acceptance criterion?

Build next:

- Emit explicit tags in generated tests:

```ts
/**
 * @covers PROJ-123:AC-2
 */
```

- Parse those tags during indexing.
- Add semantic matching as a fallback, not as the primary source of truth.
- Show covered and uncovered ACs in the dashboard.
- Add a "Generate test" action for uncovered ACs.

This is the most important product bridge between QA, product requirements, and
developer-owned tests.

## 6. Add A CI Coverage Gate

`raiken ci` can already run affected tests. The next step is to let teams gate a
pull request on requirement coverage.

Build next:

- Optional config for required AC coverage.
- CI output showing missing AC coverage.
- Non-zero exit when the configured threshold is not met.
- PR comment section explaining the uncovered ACs.

This turns Raiken from "test helper" into "release confidence tool."

## 7. Clean Up Test Infrastructure

The core test suite is strong. The dashboard now has an Nx test target. But the
test surface is uneven.

Clean up next:

- Add shared helpers for Playwright availability checks.
- Add shared helpers for stub pages and temp discovery databases.
- Add dashboard route/settings tests.
- Install Playwright browsers in CI if browser integration tests are expected to
  run there.
- Triage existing dashboard accessibility lint failures.

The goal is not coverage theater. The goal is that important product behavior is
cheap to verify.

## 8. Improve Beta Onboarding

Beta users should not need founder-level context to try Raiken.

Improve next:

- A 5-minute quickstart linked from `BETA_TESTER_GUIDE.md`.
- Better next-step hints after commands.
- Consistent `--json` output for automation-facing commands.
- Clear auth troubleshooting for SSO, stale sessions, and empty discovery.
- Cleaner error messages when provider keys are missing or invalid.

## Recommended Order

1. Schema migration runner.
2. Persistent chat history.
3. CLI packaging smoke test.
4. Acceptance-criteria extraction.
5. AC-to-test coverage.
6. CI coverage gate.
7. Test infrastructure cleanup.
8. Beta onboarding polish.

This order keeps the foundation ahead of the features. That matters because
Raiken is a memory-heavy tool. If the memory layer is fragile, every impressive
feature becomes fragile too.
