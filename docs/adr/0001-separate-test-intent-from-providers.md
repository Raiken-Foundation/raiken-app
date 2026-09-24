# Separate test intent from source and execution providers

Status: Proposed, 2026-09-08.

Raiken is expanding from Playwright test generation into diagram- and backlog-driven test-case maintenance. Storing this new intent directly in framework code, or duplicating it inside each ticket provider, would make source updates and additional runners expensive to support consistently.

The proposed decision is to persist versioned, framework-neutral requirements and test cases, linked to immutable source snapshots and separately versioned executable artifacts. Source adapters, document decoders, and test framework adapters are distinct interfaces. The existing AI-provider module supplies model transport across the shared workflow.

This adds reconciliation, provenance, and revision-management work. In return, a requirement can have multiple sources and executable implementations without duplicating coverage, review, or repair policy. Provider-specific syntax and failure semantics remain inside adapters; unsupported capabilities stay explicit.

A per-provider workflow would be simpler for the first demonstration but would duplicate correctness logic. A universal plugin interface would obscure unrelated capabilities. Both alternatives are rejected in this proposal. Built-in registered adapters are sufficient until real implementations establish a stable extension contract.

The first implementation must prove the model with Jira and GitHub source fixtures; the execution interface must subsequently be proved with Playwright and a second real framework before broad multi-framework support is claimed. See the [implementation plan](../design/provider-independent-testing-plan.md) for contracts, migration, and acceptance evidence.
