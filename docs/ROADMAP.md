# Raiken Roadmap

> Last updated: v0.5.0 (Feb 2026)

This document is the single source of truth for what we're building, what we're not, and why. Every item has a priority (P0–P3) that reflects **impact on the core vision**, not effort or enthusiasm.

---

## Vision

Raiken is a **local-first, developer-centric CLI** that understands a codebase well enough to generate, run, and repair end-to-end tests as the project evolves. It is not a cloud test platform. It is not a team-collaboration product. It is a tool a single engineer installs, points at their app, and trusts because its decisions are **explainable from code + DOM evidence**, not from a prompt.

### What makes Raiken different in the 2026 landscape

The AI-test-automation space is crowded (Meticulous, Octomind, QA Wolf, Autify, Momentic, Checkly). Most competitors are cloud-hosted, SaaS-billed, and treat the codebase as a black box they crawl against. Raiken's wedge is the opposite:

1. **Local-first.** Your code, your graph, your DB. Nothing leaves the machine unless you opt in.
2. **Explainable impact.** Every affected-test suggestion cites the symbol, line, and edge in the graph — no "the AI said so."
3. **Memory that compounds.** Selector history, site knowledge, and symbol edges persist in SQLite and get stronger with each run.
4. **Code-first, not prompt-first.** We read your AST, your routes, and your DOM before we write a single test line.

### What Raiken is explicitly not

- Not a cloud test-run platform (Checkly, QA Wolf own that).
- Not a no-code visual test builder (Autify, Octomind own that).
- Not a full team-collaboration suite (Linear, GitHub, Notion own that).
- Not a cross-browser farm (BrowserStack, Sauce Labs own that).

Items that push Raiken toward those categories are **deferred** below, not killed, but they are not the priority.

---

## Priority definitions

| Tier | Meaning | Criteria |
|------|---------|----------|
| **P0** | Ship-blocking for adoption. Work starts now. | Either on the critical path for Tier-1 users, or removes friction measurable in install-to-first-test time. |
| **P1** | Clear differentiator or critical gap. Next after P0. | Directly serves a wedge from the vision section. Competitors either lack it or do it worse. |
| **P2** | Quality-of-life or smaller gap. Scheduled after P1. | Improves DX for existing users but doesn't change who adopts Raiken. |
| **P3** | Nice-to-have. No schedule. | Tracked so we don't forget, but will not block anything. |
| **Deferred** | Out of scope until core thesis is validated. | Contradicts or dilutes the local-first / dev-first wedge, or has unproven demand. |

---

## P0 — Ship-blocking

| ID | Item | Why P0 |
|----|------|--------|
| **P0-1** | **CI/CD: `raiken ci` + GitHub Action** | CI is table stakes. Without a PR comment showing impact + affected tests, Raiken never gets adopted by a team. Reuses `TicketAnalyzer` + `GraphQueryService` already built. |
| **P0-2** | **Multi-provider LLM** | Locking users to OpenRouter is a non-starter for any team with existing OpenAI/Anthropic/Azure contracts. |
| **P0-3** | **Persistent chat history** | Losing context on server restart is the single biggest "this feels unfinished" complaint. Needs new `conversations` + `messages` tables. |
| **P0-4** | **Schema migration runner** | Blocks P0-3 and every future schema change. Without this, every update risks breaking `.raiken/raiken.db`. |

---

## P1 — Differentiators and critical gaps

| ID | Item | Why P1 |
|----|------|--------|
| **P1-1** | **API mocking in generated tests (`page.route`)** | Tests that hit real backends are flaky by default. Generating mocks from captured network traffic is directly on-wedge (code + runtime evidence). |
| **P1-2** | **Backend / API testing with contract awareness** | Frontend E2E is crowded; backend contract testing against OpenAPI/JSON Schema is not. Raiken's symbol graph already knows route handlers — this is a straightforward extension and a real differentiator. |
| **P1-3** | **Multi-language symbol graph (Python, Go)** | JS/TS-only kills adoption in any polyglot org. Uses `tree-sitter` so no per-user toolchain. |
| **P1-4** | **Test coverage mapping** | "Which tests cover this symbol?" is the question our graph can uniquely answer. Surface it in the dashboard and CLI. |
| **P1-5** | **Flaky-test detection + AST-aware self-healing** | The one problem every team has and nobody solves well. Our differentiator vs DOM-only healers (Playwright's Healer agent, Testim, etc.) is that we see the *cause* of the break: `git log` + AST + symbol graph tell us a component was renamed or a selector moved, so we can propose the right fix instead of hunting through a re-rendered DOM. Inputs: `test_outcomes` stats (flake rate), selector history, graph edges (`test → symbol`), and the pending diff. |
| **P1-6** | **Runtime coverage capture** | Dev-server proxy that records which handlers and DOM paths real traffic hits. Adds `runtime`-provenance edges to the graph. Turns the "explainable impact" story into "observed, not inferred." |
| **P1-7** | **`raiken doctor` diagnostic command** | Removes the #1 support-load driver: "it doesn't work and I don't know why." |
| **P1-8** | **`npx raiken init` zero-install** | Drops install friction to 30 seconds. High leverage, low effort. |
| **P1-9** | **AC extractor (lenient mode)** | Parses each synced ticket's body into discrete acceptance criteria using LLM with structured output. Stores them in a new `ticket_acceptance_criteria` table keyed by ticket ID. Lenient: implied ACs get extracted from free-text descriptions, not just explicit checklists. Foundation for P1-10 and P1-11. |
| **P1-10** | **AC ↔ test coverage matrix + pickup-time UI** | For each AC, link covering tests via two strategies: explicit `@covers TICKET-ID AC-N` JSDoc tag emitted by the agent at generation, plus semantic-similarity fallback via embeddings. Surfaces in the dashboard at ticket pickup as a per-AC list with gap rows and "Generate test" CTAs. The single most valuable checkpoint per the agreed lifecycle ranking. |
| **P1-11** | **CI coverage gate (extends P0-1)** | `raiken ci` reads the AC coverage matrix and exits non-zero if a configured threshold is unmet. Renders into the PR comment alongside impact analysis. Hard dependency on P0-1 and P1-9/P1-10 — slots in after they ship. |

---

## P2 — Quality of life

| ID | Item | Notes |
|----|------|-------|
| **P2-1** | Local LLM support (Ollama) | Falls out of P0-3 if the provider interface is right. Small segment; don't over-invest. |
| **P2-2** | Model selection UI in dashboard | Part of P0-3 follow-up. |
| **P2-3** | Cost tracking and token budgets | Per-session visibility. Important once team usage scales. |
| **P2-4** | Visual regression testing | Downgraded from High: Playwright has native `toHaveScreenshot`. Add scaffolding, not a full baseline service. |
| **P2-5** | SPA-programmatic navigation in discovery | Detect React Router `push`, JS-triggered transitions. Wave 0 fixed structural links; this covers non-anchor navigation. |
| **P2-6** | Form interaction during discovery | Opt-in: fill + submit safe forms to discover post-submission pages. |
| **P2-7** | Incremental re-discovery | Content-hash pages, only re-crawl changed. |
| **P2-8** | File watcher in dashboard | Detect external edits to test files. |
| **P2-9** | JSON structured log output (`--json`) | CI integration requirement. |
| **P2-10** | Consistent next-step guidance across commands | Part of onboarding polish. |
| **P2-11** | First-run dashboard tour | Downgraded from Medium: CLI-first workflow means the dashboard is secondary. |
| **P2-12** | Discovery data cleared by `clearProject` | Minor bug. |
| **P2-13** | API key storage via OS keychain | Replaces plaintext `.env` storage. |
| **P2-14** | Auth session rotation warnings | Detect stale `auth-state.json` and prompt refresh. |
| **P2-15** | Multi-repo workspace (federation mode) | Union of N per-repo databases read-only. Defers the shared-DB rewrite. |
| **P2-16** | Changelog + release tooling | `changesets` or equivalent. Needed before v1.0. |
| **P2-17** | Test-failure ticket-drift detection | When a test fails, look up its covered ACs, fetch ticket changelog since last passing run, surface "ticket changed at T, AC text changed; assertion may be stale" vs. real failure. Checkpoint #3 in the ticket-as-source-of-truth lifecycle. Depends on P1-9/P1-10. |

---

## P3 — Tracked but unscheduled

| ID | Item | Notes |
|----|------|-------|
| **P3-1** | Parallel test generation | Optimization, not adoption driver. |
| **P3-2** | Hardcoded embedding dimensions | Only matters if we swap embedding models. |
| **P3-3** | Benchmark harness for agent + generator | Needed before making public perf claims. |
| **P3-4** | Cross-project knowledge (shared DB) | Post-P2-15 evolution. Unproven demand. |

---

## Deferred — out of scope until core thesis is validated

These items were on the roadmap or in feature docs but are **not aligned with the local-first, dev-centric wedge** in 2026. They are not deleted — each has a corresponding feature doc — but they will not be worked on in the current phase.

| Item | Status | Reason |
|------|--------|--------|
| **Cloud Accounts** (`FEATURE_CLOUD_ACCOUNTS.md`) | Deferred | Moving to a cloud/billing platform undercuts the local-first wedge. Every competitor already has cloud; that's not where we win. Revisit only after P0 + P1 have shipped and users are explicitly asking. |
| **Collaborative Test Graph** (`FEATURE_COLLABORATIVE_TEST_GRAPH.md`) | Deferred | Depends on Cloud Accounts. Real-time multi-user graph editing is months of engineering for unproven demand. GitHub PRs already solve "teams collaborate on tests." |
| **Business Context Integration — developer-scoping variant** (`FEATURE_BUSINESS_CONTEXT_INTEGRATION.md`) | Partially done, rescoped | The already-shipped GitHub/Jira/Linear ticket sync stays. The "scope to logged-in dev via Raiken account" part is deferred with Cloud Accounts. Current implementation uses local git config + PATs and works without an account. |

### Items removed from the roadmap

These were previously tracked but don't serve the vision. Killed, not deferred:

| Removed | Reason |
|---------|--------|
| Docker image | Modern CI uses setup-actions, not containers. Added maintenance, no adoption lift. |
| Cypress / Jest execution support | Playwright won the browser-test space. Supporting two stacks we wouldn't pick ourselves is a drag. |
| Light theme | Non-differentiator. Users asking for this are not our ICP. |
| Keyboard shortcuts reference panel | Micro-polish. Ship shortcuts inline in the UI instead. |
| Dashboard project switcher | Per-repo CLI is the switcher. |
| MCP server (`apps/mcp`) | Not needed. CLI + dashboard cover the dev surface; IDE-native integration via MCP adds maintenance burden for unclear return. Revisit only if real user demand emerges. |
| Robots.txt handling | User is testing their own app. N/A. |
| Rate limiting in discovery | Same — own app, not a public crawl. |
| Slack / Discord notifications | CI already does this via GitHub Action outputs. |
| Webhook support | CI does this. |
| Database export / import | Git already versions `.raiken/` if users opt in. |
| Request signing / compliance audit log | Pre-PMF. Compliance work when enterprise asks. |

---

## Recently shipped (context)

The following items from older versions of this document are **done** and removed from the active list:

- Symbol-level code graph with explainable edges (`GraphEdge`, `ParsedSymbol`)
- Incremental embedding updates (live file watching + per-file embeddings)
- Function/class-level chunking via symbol extraction
- Intelligent DOM-driven selector construction (no regex fallback)
- LLM-based continuation detection (no regex)
- GitHub + Jira + Linear ticket sync with branch detection
- Selector history recording wired into every browser action (Wave 0)
- Real page depth in agent-discovered pages (Wave 0)
- DOM-derived selectors for discovered links (Wave 0)
- Storage-state cookie sanitization in crawler (Wave 0)
- Resume-with-empty-queue dead-end fix (Wave 0)

---

## Priority summary

| Tier | Count |
|------|-------|
| P0 | 4 |
| P1 | 11 |
| P2 | 17 |
| P3 | 4 |
| Deferred | 3 docs |
| Removed | 12 |

## Suggested next 5 weeks

CI/CD leads because it's the single biggest adoption lever and has no hard dependency on the other P0 items (it reuses `GraphQueryService` and `TicketAnalyzer`, both already shipped). Migrations slot in before persistent chat since chat is the first feature that adds new tables.

```
Week 1    P0-1a  raiken ci command (core: diff → impact → test runner → JUnit/JSON output)
Week 2    P0-1b  GitHub Action template + PR comment renderer + action.yml
Week 3    P0-4   schema migration runner
Week 4    P0-3   persistent chat history (blocked on P0-4)
Week 5    P0-2   multi-provider LLM
```

P1-1 (API mocking), P1-2 (backend testing) and P1-3 (multi-language) come right after and P1-2/P1-3 can run in parallel since they touch different code paths.

The **ticket-as-source-of-truth** track (P1-9 → P1-10 → P1-11 → P2-17) is sequential and depends on P0-1 being live so the CI gate has a host. Suggested run after the post-P0 P1 fan-out:

```
Week 6    P1-9   AC extractor (lenient)
Week 7    P1-10  AC ↔ test coverage matrix + pickup-time UI
Week 8    P1-11  CI coverage gate (extends raiken ci)
Week 9+   P2-17  test-failure ticket-drift detection (after some real usage data)
```
