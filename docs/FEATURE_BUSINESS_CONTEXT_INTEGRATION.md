# Feature: Business Context Integration (Jira + GitHub)

> **Status:** Planned  
> **Priority:** High  
> **Complexity:** Medium  
> **Dependencies:** Orchestrator tool-router, DOM capture, API integrations

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
Integrate Jira and GitHub context on demand so Raiken can update tests in line with business intent, without overriding DOM reality.

### Core Principles
| Principle | Description |
|---|---|
| **DOM-first** | UI DOM remains the ground truth for selectors and structure |
| **Context-enriched** | Jira + PR discussions add business intent and change rationale |
| **On-demand** | Fetch only when asked or when a ticket/PR is referenced |
| **Traceable** | Tests can link back to Jira keys or PR URLs |
| **Conflict-aware** | If Jira/PR conflicts with DOM, DOM wins but conflict is reported |

---

## What It Does

### Jira (On-Demand)
Fetches:
- Summary
- Description
- Acceptance criteria
- Priority / severity
- Linked issues / epics

Uses:
- Adjust expected behavior and assertions
- Explain why tests should change

### GitHub (On-Demand)
Fetches:
- PR title + description
- Review comments + threads
- Labels + linked issues

Uses:
- Identify behavioral changes discussed in review
- Align tests with decisions made during code review

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

1. Detect references (Jira key / PR number / URL).
2. Fetch context on demand (if enabled).
3. Summarize into business intent + change deltas.
4. Generate or update tests using DOM + business context.

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

## Open Questions
1. Should Jira/GitHub context be cached or always fetched live?
2. Should the system auto-detect Jira keys in branch names?
3. Should we support a "business context only" mode?

