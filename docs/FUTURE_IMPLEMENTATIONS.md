# Future Implementations

This document is the long-term direction. It is not a sprint plan.

The north star is:

> Raiken becomes the local-first QA intelligence layer for a software project.

It should understand the repo, observe the product, connect tests to business
intent, and explain what should be tested when the system changes.

## Principle: Stay Local-first Until The Market Pulls Us Elsewhere

Many test automation products become cloud dashboards. That is a valid business,
but it is not Raiken's starting advantage.

Raiken's advantage is that it can run inside the developer's repo and CI:

- source code stays local;
- generated tests stay in the repo;
- project memory lives in `.raiken/raiken.db`;
- users bring their own model provider;
- CI runs in the customer's infrastructure.

Future cloud features should be optional. They should not be required for the
core product to work.

## 1. API Mocking In Generated Tests

Browser tests become flaky when they depend on real backend state. Raiken should
learn enough about network calls to generate stable mocks when appropriate.

The future shape:

- Capture relevant network calls during discovery or drafting.
- Generate `page.route` mocks for stable flows.
- Let users approve or edit the mock.
- Store why the mock exists and where it came from.

The product value is simple: generated tests should pass for deterministic
reasons, not because the backend happened to be in the right state.

## 2. Backend And Contract Testing

Raiken starts with E2E browser tests, but the code graph can also point inward:
routes, handlers, schemas, and services.

The future shape:

- Parse route handlers and API contracts.
- Generate request/response contract tests.
- Connect frontend flows to backend handlers.
- Show changed backend behavior that lacks direct test coverage.

This expands Raiken from "browser QA" to "application behavior QA" while staying
inside the developer workflow.

## 3. Multi-language Code Graph

JavaScript and TypeScript are a good first surface, but real products are often
polyglot.

The future shape:

- Add `tree-sitter` parsers for Python and Go.
- Normalize symbols into the existing graph model.
- Prioritize test-relevant symbols: routes, handlers, services, components, and
  test files.
- Support cross-language impact analysis.

The goal is not to parse every language perfectly. The goal is to understand
enough structure to make better testing decisions.

## 4. True Flaky-test Detection

`raiken doctor` catches static anti-patterns. True flake detection needs time
and evidence.

The future shape:

- Track pass, fail, timeout, and retry history by test.
- Compute flake rate and confidence.
- Compare failures against recent code changes.
- Use selector history and DOM changes to classify likely causes.
- Explain whether a failure looks flaky, stale, or like a real regression.

The output should not be "AI thinks this is flaky." It should be "this test has
failed 4 of the last 20 runs across unrelated diffs, usually on this selector."

## 5. AST-aware Test Repair

Most self-healing test tools repair from the DOM outward. They see a missing
selector and try another selector.

Raiken can repair from both directions:

- the DOM changed;
- the component changed;
- the route changed;
- the ticket changed;
- the test expectation changed.

The future shape:

- Detect renamed symbols, moved components, and changed routes.
- Rank repair candidates using graph edges and recent diffs.
- Propose patches with evidence.
- Keep human approval for risky edits.

The value is semantic repair, not cosmetic selector swapping.

## 6. Requirements-aware QA

This is the most important future direction.

Today, tests usually answer: "does this code still behave this way?"

Raiken should also answer: "does this implementation prove the ticket's intended
behavior?"

The future shape:

- Extract acceptance criteria from Jira, Linear, and GitHub issues.
- Store each AC as structured local data.
- Link tests to ACs with explicit tags and semantic fallback.
- Show coverage gaps at ticket pickup time.
- Generate tests for uncovered ACs.
- Gate CI on required AC coverage.
- Detect ticket drift when a test fails after requirements change.

This is how Raiken becomes more than a test generator. It becomes a bridge
between product intent and executable tests.

## 7. Better Discovery

Discovery should become more complete without becoming dangerous.

The future shape:

- Detect SPA programmatic navigation, not only links.
- Safely interact with forms during opt-in discovery.
- Re-crawl only changed pages.
- Warn when auth state is stale.
- Clear discovery data when project state is cleared.
- Show exactly which discovered artifacts were used to generate a test.

The rule is: explore enough to be useful, but never surprise the user.

## 8. Developer Experience

Raiken should become easy to try, easy to automate, and easy to trust.

The future shape:

- `npx raiken init` for zero-install evaluation.
- Consistent `--json` output.
- Better next-step hints after commands.
- OS keychain support for API keys.
- File watching in the dashboard.
- Release tooling and changelog automation.

These are not flashy features. They reduce friction, and friction kills beta
tools.

## 9. Enterprise Path

The enterprise version should not start as "upload everything to Raiken cloud."

The stronger offer is:

> Raiken runs in your repo and CI, keeps sensitive data local, and gives your
> team explainable test generation and impact analysis.

Possible enterprise additions:

- Assisted onboarding.
- Paid pilots.
- Private deployment guidance.
- Audit/export tools for regulated teams.
- Optional hosted reporting after local-first usage is proven.
- SSO only if an account layer becomes necessary.

## Deferred Ideas

These are not current priorities:

- Cloud accounts as a required product layer.
- Hosted test storage as the default.
- Real-time collaborative graph editing.
- Hosted browser farm.
- No-code visual test builder.
- Notification products around Slack, Discord, or webhooks.

They may be useful later. But building them too early would move Raiken toward
the crowded cloud QA category instead of strengthening the local developer-tool
wedge.
