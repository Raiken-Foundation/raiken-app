# Feature: Collaborative Test Graph

> **Status:** Planned  
> **Priority:** Medium‑High  
> **Complexity:** High  
> **Dependencies:** Auth, real‑time sync, shared graph storage, model execution

---

## Executive Summary
Enable teams to collaborate in a web platform where multiple users build and maintain a shared **test graph**. The graph represents suites, flows, and assertions, and can be interpreted and executed by the model to generate or run Playwright tests.

---

## Problem Statement

### Current Limitation
Tests live as files and are hard to understand collectively:
- Multiple contributors add tests without a shared structure
- It’s difficult to visualize coverage and dependencies
- Collaboration is limited to PR review

### Impact
- Duplicate or inconsistent test flows
- Lack of shared testing strategy
- Higher onboarding cost for new team members

---

## Solution Overview
Provide a collaborative UI where users build a **graph representation** of the test suite. The model can:
1) translate graph nodes into test code  
2) execute flows as a sequence  
3) update tests when requirements change  

---

## Core Concepts

### Test Graph
A directed graph that represents test intent and execution order.

**Node types** (examples):
- **Suite**: High‑level grouping (e.g., “Checkout Flow”)
- **Step**: A user action (click, fill, navigate)
- **Assertion**: Expected result
- **Data**: Test data or fixtures
- **Navigation**: Page transition / route

**Edge types**:
- `sequence` (step order)
- `depends_on` (requires a prerequisite)
- `uses_data` (data binding)

---

## User Experience

### Collaboration
- Multiple users can edit the same graph
- Presence indicators show who is active
- Changes are synced live

### Graph‑Driven Test Generation
- User builds a flow visually
- Model converts graph to Playwright tests
- Model can re‑generate tests after graph edits

### Graph‑Driven Execution
- User selects a graph flow
- Model executes steps with Playwright
- Results annotate the graph (pass/fail per node)

---

## Model Interaction

The model uses the graph as a **structured intent**, not just free‑form text:

- Graph → test plan prompt
- Nodes → test steps and assertions
- Edges → execution order and dependencies

The model can also **suggest missing steps** or **highlight weak coverage** based on DOM context.

---

## Orchestrator Integration

1. User opens graph and selects a flow  
2. Orchestrator receives graph JSON  
3. Model generates or executes tests  
4. Results are written back to graph metadata  

---

## Data Model (Draft)

```json
{
  "graphId": "checkout-flow",
  "nodes": [
    { "id": "suite-1", "type": "suite", "label": "Checkout Flow" },
    { "id": "step-1", "type": "step", "action": "click", "selectorHint": "button:has-text('Checkout')" },
    { "id": "assert-1", "type": "assertion", "expect": "text", "value": "Order confirmed" }
  ],
  "edges": [
    { "from": "suite-1", "to": "step-1", "type": "sequence" },
    { "from": "step-1", "to": "assert-1", "type": "sequence" }
  ],
  "metadata": {
    "lastRun": "2026-01-20T00:00:00Z",
    "status": "passing"
  }
}
```

---

## Permissions & Audit
- Roles: Owner, Editor, Viewer
- Audit log for changes
- Graph versioning / rollback

---

## Guardrails
- Prevent destructive actions unless explicitly confirmed
- Require node validation before execution
- Warn on ambiguous or missing selectors

---

## Success Metrics
| Metric | Target |
|---|---|
| Team adoption of graph flows | >60% |
| Reduced duplicate tests | >30% |
| Faster onboarding | >40% reduction |

---

## Open Questions
1. Should graph edits automatically regenerate tests or require confirmation?
2. Should graph execution be local only, or CI‑triggered?
3. How should we map graph steps to DOM selectors (AI vs user‑specified)?
