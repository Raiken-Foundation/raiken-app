# Requirements to test cases

Status: Proposed. Captures the user's requested direction; this feature is not yet implemented.

Implementation planning: [provider-independent requirements and testing](provider-independent-testing-plan.md), including adapter contracts, shared behavior, migration, and phased delivery.

## Product outcome

Raiken turns flow diagrams, user-story diagrams, and Jira/GitHub backlog tickets into traceable test cases. It compares those requirements with existing tests and proposes additions or updates. Reviewed cases can subsequently produce executable tests using a supported framework.

The desired behavior comes from requirements. Application discovery supplies evidence about how to interact with the implementation. A mismatch remains visible as a possible defect or an unresolved requirement.

## Existing implementation

- Jira and GitHub provider classes fetch individual tickets and expose assigned-ticket retrieval.
- `syncCurrentTicket` resolves an explicit or branch-associated ticket and invokes impact analysis.
- Ticket impact analysis represents affected source/test files and create/update/review suggestions.
- `cover` can resolve a numbered acceptance criterion from a ticket description into a generation target.
- Recorded navigation flows represent observed URLs and selectors.

These are implementation foundations, not evidence that live Jira/GitHub integrations or full backlog synchronization have been verified. The current provider contract does not expose comprehensive project/board backlog queries. Executable generation, execution, and repair currently target Playwright.

## Proposed workflow

1. Select diagrams, stories, or a scoped backlog: repository/project, ticket selection, and relevant filters. Exact supported diagram formats remain undecided.
2. Import source records with provider, stable source identity, URL, revision, and retrieval time. Preserve references to diagram nodes and ticket criteria. Repeated imports must not duplicate cases.
3. Extract actors, preconditions, actions, decisions, expected outcomes, and acceptance criteria into a shared requirements model. Mark inferred cases and missing information explicitly. A diagram relationship alone does not establish a testable expected outcome.
4. Compare requirements with existing cases and tests. Surface missing coverage, changed requirements, duplicates, conflicts, and tests needing review. Similarity alone must not count as verified coverage.
5. Propose a reviewable case change: reason, source evidence, existing behavior, proposed steps, test data, and expected outcomes.
6. Generate or update executable tests through a framework-specific integration, using observed application evidence for interaction details.
7. Run tests and link results back to cases and requirements. Distinguish planned, implemented, executed, passing, failing, blocked, and stale coverage.

## Improving existing cases

- An uncovered story criterion can produce a new case.
- A bug ticket can produce a regression case that fails on the known defective behavior and passes after its correction.
- A changed criterion can mark linked cases for review and propose a focused update.
- A ticket and diagram that disagree produce a visible conflict rather than an invented resolution.
- Comments, suggestions, and inferred edge cases retain their provenance; they do not silently become approved requirements.
- Changes to expected behavior require an explicit reviewed requirement change. A passing rerun does not authorize weakening an assertion.

## Boundaries

- Keep framework-neutral test cases separate from generated Playwright or future framework artifacts.
- Model requirements separately from observed navigation flows; requirements need not have URLs or selectors yet.
- Import is read-only toward ticket systems by default. Posting comments, changing statuses, or writing results back is separate scope requiring explicit authorization.
- Backlog ingestion needs pagination, scoped credentials, retry/rate-limit handling, change detection, and visible partial-import errors before it can be called reliable.
- Ticket and diagram contents are untrusted input to extraction and generation, including text that attempts to issue agent instructions.

## Acceptance evidence

- The same source revision imported twice creates no duplicate requirements or cases.
- Cases can be traced to exact source criteria or diagram branches.
- A source edit marks affected cases stale without altering unrelated cases.
- Explicit failure branches generate corresponding cases; omitted behavior is flagged or labeled as a suggestion.
- Existing valid coverage is reused, and proposed edits preserve unrelated assertions.
- Conflicting or ambiguous sources remain visible for review.
- Partial provider failures cannot appear as a complete synchronized backlog.
- Generated regression tests detect deliberately broken fixtures with retries disabled.

## Decisions still open

- Initial diagram inputs: image/PDF uploads, structured formats, or both.
- Initial delivery surface: CLI, dashboard, or both.
- First backlog scope: selected tickets, assigned work, repository/project, or board/sprint.
- Initial deliverable: reviewable test cases, executable tests, or both.
- The next executable framework beyond Playwright, if included in the first release.

These decisions are recorded as open rather than assumed approvals.
