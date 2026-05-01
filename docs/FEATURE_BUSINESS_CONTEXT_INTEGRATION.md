# Feature: Business Context Integration (Jira + GitHub + Linear)

> **Status:** Partially shipped (Feb 2026). Active.
> **Priority:** P1 (remaining work), see `ROADMAP.md`
> **Complexity:** Medium
> **Dependencies:** Orchestrator tool-router, DOM capture, API integrations, local git config + provider PATs
>
> **Scope change (Feb 2026):** This feature originally depended on `FEATURE_CLOUD_ACCOUNTS.md` for "developer-scoped" ticket fetching. Cloud Accounts is now deferred, so the account-scoping variant is deferred with it. The shipped implementation uses **local git config** (to detect the active repo and branch) and **provider PATs** (stored in `.env` or the OS keychain once P2-13 lands) and works without a Raiken account. The "scope to logged-in dev" enhancement is revisited only if/when Cloud Accounts is revived.
>
> **What already works:** GitHub Issues/PRs, Jira, and Linear ticket sync triggered by branch name parsing; symbol-level impact analysis via `GraphQueryService`; dashboard ticket-sync bar with confidence pills and affected symbols.

---

## Executive Summary
Raiken can fetch Jira tickets and GitHub PR discussions on demand to enrich test generation and test updates. The DOM remains the primary source of truth for selectors and structure, while business context explains why tests should change when requirements evolve.

---

## Problem Statement

### Current Limitation
Tests can fail when requirements change weeks after a feature ships:
- The UI and code are correct for the new requirement.
- The test still reflects the old requirement.
- The failure is interpreted as a bug rather than a requirement change.

### Impact
- Tests drift away from business requirements.
- QA and devs must manually re-interpret context.
- Test updates are delayed or inconsistent.

---

## Solution Overview
Integrate Jira and GitHub context on demand so Raiken can update tests in line with business intent, without overriding DOM reality. Context is scoped to the logged-in developer — Raiken fetches only their assigned tickets, their PRs, and their branches.

### Core Principles
| Principle | Description |
|---|---|
| **Developer-scoped** | Fetch tickets and PRs assigned to or authored by the current developer, not the whole backlog |
| **DOM-first** | UI DOM remains the ground truth for selectors and structure |
| **Context-enriched** | Jira + PR discussions add business intent and change rationale |
| **On-demand** | Fetch only when asked or when a ticket/PR is referenced |
| **Traceable** | Tests can link back to Jira keys or PR URLs |
| **Conflict-aware** | If Jira/PR conflicts with DOM, DOM wins but conflict is reported |

---

## How Identity Scoping Works

When a developer is logged in to Raiken (via `FEATURE_CLOUD_ACCOUNTS.md`), their linked Jira and GitHub identities determine what gets fetched:

| Source | Scoping | Fallback |
|--------|---------|----------|
| Jira | Tickets assigned to the developer, or where they are the reporter | Explicit ticket key (e.g., "JIRA-421") bypasses scoping |
| GitHub PRs | PRs authored by the developer on the current repo | Explicit PR number (e.g., "#384") bypasses scoping |
| GitHub branches | Current git branch, matched to PRs and linked issues | Manual branch override in config |

This means when a developer says "update my tests", Raiken knows which tickets and PRs are *theirs* — it doesn't pull the entire project backlog.

### Identity Mapping

```json
// Stored in the developer's Raiken account profile
{
  "integrations": {
    "github": {
      "username": "armand-dev",
      "linkedAt": "2026-02-21T12:00:00Z"
    },
    "jira": {
      "email": "armand@company.com",
      "accountId": "5f4d3c2b1a",
      "linkedAt": "2026-02-21T12:00:00Z"
    }
  }
}
```

---

## What It Does

### Jira (On-Demand)
Fetches (scoped to the logged-in developer):
- Tickets assigned to them or where they are the reporter
- Summary, description, acceptance criteria
- Priority / severity
- Linked issues / epics
- Recent comments and status transitions

Uses:
- Adjust expected behavior and assertions
- Explain why tests should change
- Auto-suggest test updates when assigned tickets move to "Done"

### GitHub (On-Demand)
Fetches (scoped to the logged-in developer):
- PRs authored by them on the current repo
- PR title + description
- Review comments + threads
- Labels + linked issues
- Files changed (for test relevance matching)

Uses:
- Identify behavioral changes discussed in review
- Align tests with decisions made during code review
- Auto-detect which tests may need updating based on changed files

---

## Typical Flow

### Scenario: Requirement Updated After Tests
1. Test fails after a business change.
2. Jira ticket describes new behavior.
3. Raiken reads Jira + DOM.
4. Raiken updates test assertions and steps.

Result: Test updated without implying the code is incorrect.

---

## Example UX

### Jira Example
User: "Update tests for JIRA-421"

System:
- Fetch Jira ticket (on demand)
- Extract acceptance criteria
- Compare with DOM
- Update test steps/assertions

### GitHub Example
User: "Update tests for PR #384"

System:
- Fetch PR discussion
- Identify requirement changes in review threads
- Adjust test assertions accordingly

---

## Orchestrator Behavior

1. Identify the logged-in developer (from Raiken account session).
2. Detect references (Jira key / PR number / URL) or infer from current branch.
3. Fetch context scoped to that developer (if enabled).
4. Summarize into business intent + change deltas.
5. Generate or update tests using DOM + business context.

---

## Configuration

```json
{
  "integrations": {
    "github": {
      "enabled": true,
      "org": "my-org",
      "repo": "my-repo",
      "tokenEnv": "GITHUB_TOKEN"
    },
    "jira": {
      "enabled": true,
      "baseUrl": "https://company.atlassian.net",
      "tokenEnv": "JIRA_TOKEN",
      "emailEnv": "JIRA_EMAIL"
    }
  }
}
```

---

## Guardrails
- If Jira/GitHub is unavailable: fallback to DOM + code.
- If multiple tickets/PRs are referenced: ask to clarify.
- If context conflicts with DOM: DOM wins, but conflict is surfaced.

---

## Success Metrics
| Metric | Target |
|---|---|
| Tests updated correctly after requirement changes | >85% |
| Reduced false test failures due to spec drift | >50% |
| Manual clarification rate | <20% |

---

## Phase 2: Acceptance Criteria as Source of Truth

> **Status:** Planned. Roadmap items P1-9, P1-10, P1-11, P2-17.

### Why this exists

Phase 1 (already shipped) answers *"this ticket affects which tests?"* — impact analysis driven by the symbol graph. That tells you what's at **risk** when code changes, but it doesn't tell you whether the ticket's requirements are actually **proven** by tests.

Phase 2 closes that gap. It treats each ticket's acceptance criteria as a specification and tests as proofs that the spec is met. A ticket with 4 ACs and only 2 covered by passing tests is **not done**, regardless of how many tests are in the impact zone.

The two views are complementary, not competing:

| Question the developer is asking | Answered by |
|---|---|
| "I changed this code. What tests might break?" | Impact analysis (Phase 1) |
| "This ticket says X. Do my tests prove X?" | AC coverage (Phase 2) |

Both ship and both surface in the dashboard and CI. Off-ticket work (refactors, hotfixes, dependency bumps) still gets risk coverage from Phase 1 even when there is no ticket to compare against.

### Three-layer model

1. **AC extractor** (P1-9). On ticket sync, an LLM call with a structured-output schema parses the ticket body into discrete acceptance criteria. **Lenient mode** is the default: implied ACs are extracted from free-text descriptions, not just explicit checklists or "Acceptance Criteria" sections. Structured ACs (Given/When/Then, Markdown checkboxes) are preferred when present; free-text falls back to LLM-inferred ACs labeled with `provenance: "inferred"`.
   - Storage: new `ticket_acceptance_criteria` table, columns: `ticket_id`, `ac_index`, `text`, `source` (`structured` | `inferred`), `extracted_at`.
   - Re-extraction: triggered on ticket update or branch change.

2. **AC ↔ test coverage matrix** (P1-10). For each AC, link covering tests via two strategies combined:
   - **Explicit tagging.** When the agent generates a test for a ticket, it inserts a JSDoc tag: `@covers JIRA-421:AC-3`. Parsed back during indexing.
   - **Semantic inference.** Embedding similarity between AC text and test `describe`/`it` names + assertion strings. Threshold-gated to avoid false positives.
   - Storage: new `ac_test_coverage` table, columns: `ac_id`, `test_file`, `test_name`, `link_kind` (`explicit` | `semantic`), `confidence`, `last_validated_at`.
   - The matrix is rebuilt on any of: ticket sync, test file change (file watcher), explicit `raiken sync-coverage` command.

3. **Surfacing.** Three checkpoints, ranked by value:

   | # | Moment | Surface | Status |
   |---|--------|---------|--------|
   | 1 | **Ticket pickup** | Dashboard `TicketSyncBar` extended with per-AC rows: covered tests, gap rows with "Generate test" CTA, overall coverage % | P1-10 |
   | 2 | **PR open / CI** | `raiken ci` exits non-zero if coverage < threshold; PR comment renders coverage table alongside impact | P1-11 |
   | 3 | **Test failure** | When a test fails, surface its covered ACs and the ticket's changelog since last passing run, distinguishing "ticket moved" from "real failure" | P2-17 |

   Pre-commit hooks, post-merge checks, and pre-closure validation are explicitly **not built**. They are too noisy or too late.

### Example: pickup-time view

```
JIRA-421 — Add idempotency to orders POST
Coverage: 2/4 acceptance criteria covered

  ✓ AC-1  Request with same idempotency_key returns cached response
           └── tests/api/orders.spec.ts:42  passing  (explicit @covers)
  ✓ AC-2  New idempotency_key creates new order
           └── tests/api/orders.spec.ts:58  passing  (semantic, 0.87)
  ⚠ AC-3  Missing idempotency_key returns 400
           └── No covering test found
             [Generate test]
  ⚠ AC-4  Expired idempotency_key is rejected after 24h
           └── No covering test found
             [Generate test]
```

### Example: CI gate

```
Raiken ticket check: JIRA-421
  ✗ 2/4 acceptance criteria covered (threshold: 100%)
    Missing: AC-3 (400 on missing key), AC-4 (24h expiry)
    Suggested action: run `raiken generate --ticket JIRA-421` to draft tests for the gaps.
  Impact:
    ✓ 3/3 affected tests passing
```

### Example: failure with ticket drift

```
tests/api/orders.spec.ts > "returns cached response" failed

This test covers JIRA-421 AC-1.
The ticket was updated 2h ago; AC-1 description changed:
  - "returns cached response for 24 hours"
  + "returns cached response for 1 hour"

Likely cause: ticket moved, test assertion needs updating.
  [Regenerate assertion from ticket]  [Treat as real failure]
```

### Configuration

```json
{
  "integrations": {
    "tickets": {
      "ac": {
        "extraction": "lenient",
        "ciCoverageThreshold": 1.0,
        "semanticLinkThreshold": 0.75
      }
    }
  }
}
```

### Guardrails

- **Lenient ≠ unbounded.** Inferred ACs are capped per ticket (default 8) to prevent the LLM from hallucinating dozens of micro-criteria.
- **Confidence is exposed.** Every AC and every link carries a confidence score; UI surfaces low-confidence rows with a warning chip rather than silently treating them as solid.
- **Off-ticket work is not penalized.** If a PR has no linked ticket, the coverage gate is skipped; only the impact gate runs.
- **DOM still wins.** If an AC says "button labeled X" and the DOM has no such element, the system surfaces the conflict rather than generating a test that will always fail.

### Success metrics (Phase 2)

| Metric | Target |
|---|---|
| ACs correctly extracted from real tickets (sample-graded) | >80% |
| Coverage gaps that lead to a generated test (vs. dismissed) | >40% |
| False AC-coverage matches caught by users | <15% |
| CI gate true-positive rate (gap caught was real) | >85% |

---

## Open Questions
1. Should Jira/GitHub context be cached or always fetched live?
2. Should the system auto-detect Jira keys in branch names? (Likely yes — `feat/JIRA-421-checkout-redesign` is a common pattern.)
3. Should we support a "business context only" mode?
4. Should Raiken proactively notify when an assigned ticket's acceptance criteria change?
5. How should we handle developers with multiple Jira/GitHub accounts (e.g., contractor with two orgs)?
6. Should the identity linking happen during `raiken login` or as a separate `raiken connect` step?
7. Phase 2 — should explicit `@covers` tags be auto-inserted by the agent only, or also offered as a quick-fix in the dashboard for hand-written tests?
8. Phase 2 — when an AC is reworded but semantically unchanged, should existing links auto-survive based on embedding similarity, or always require re-validation?

