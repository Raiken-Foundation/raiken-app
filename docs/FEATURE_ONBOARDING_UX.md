# Onboarding and UX Improvements (Remaining)

> **Status:** Active. Items here map to specific priorities in `ROADMAP.md`:
> - `raiken doctor` → P1-7
> - `npx raiken` zero-install → P1-8
> - SSO auth guidance → part of P1 auth work
> - First-run dashboard tour → P2-11 (downgraded; CLI-first workflow makes the dashboard secondary)
> - Consistent next-step guidance → P2-10
> - Structured log output (`--json`) → P2-9
> - Quickstart and troubleshooting docs → polish alongside P0 items
>
> Items marked as done have been removed. This file tracks only what is still pending.

## CLI

### `raiken doctor`

Add a diagnostic command to validate:

- Node.js version
- Playwright install
- Config file validity
- Database accessibility
- App URL reachability

Output should be clean and actionable.

### Consistent next-step guidance

Every command should print the next 1-2 commands to run. Some commands already do this, but coverage is inconsistent.

### Structured log output

Add a `--json` flag for machine-readable CLI output for CI integrations.

## Auth UX

### SSO guidance

When SSO is detected, show a short checklist:

- Complete SSO in the browser window
- Confirm logged-in state
- Press Enter to save session state

Currently only basic login forms are guided; SSO flows need clearer instructions.

## Dashboard

### First-run tour

On first dashboard visit:

- Highlight discovery summary
- Show verified navigation paths
- Provide a "Generate a test" CTA

### Test generation transparency

Show which discovery artifacts (paths, selectors, pages) were used to generate a test so users can trace AI decisions.

## Docs

### Quickstart

Create a single 5-minute quickstart with these steps:

1. `npm install -g raiken`
2. `raiken init`
3. `raiken auth` (if needed)
4. `raiken discover http://localhost:3000`
5. `raiken start`

### Troubleshooting tree

Provide a decision tree for common issues:

- Auth failures
- Empty discovery results
- Missing selectors
- Native module build errors (`better-sqlite3`, `sharp`)

## Telemetry (Optional)

If added, it should be:

- Opt-in only
- Local-first (no cloud requirement)
- Minimal data collection (command timings, errors)

## Open Questions

- Should `raiken init` run in non-interactive mode for CI?
- Should CLI logs be more structured (JSON option)?
