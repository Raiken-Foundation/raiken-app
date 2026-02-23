# Onboarding and UX Improvements (Planned)

This document captures the proposed onboarding and UX improvements for Raiken. It is a
planning reference only; implementation will follow later.

## Goals

- Reduce time-to-first-value to under 5 minutes.
- Make CLI onboarding self-guided and safe by default.
- Provide clear, actionable next steps after every command.
- Align UI and CLI terminology for consistency.

## Non-Goals

- Replacing the current CLI with a GUI-only experience.
- Introducing vendor lock-in or cloud-only workflows.
- Implementing new core features (this is UX and onboarding only).

## User Journey (Target)

1) Install + init
2) Authenticate (if needed)
3) Discover
4) Generate tests
5) Review results in dashboard

## CLI Onboarding (Planned)

### `raiken init` wizard

The init command should become an interactive wizard that:

- Detects project type and test framework
- Asks for base URL (dev server)
- Asks auth type: none, username/password, SSO/provider
- Writes `raiken.config.json` with safe defaults
- Adds `.raiken/` and `storage/` to `.gitignore`

### Next-step guidance

Every command should print the next 1-2 commands to run, for example:

```
Next steps:
1) raiken auth --url http://localhost:3000/login
2) raiken discover http://localhost:3000
```

### `raiken doctor`

Add a diagnostic command to validate:

- Node.js version
- Playwright install
- Config file validity
- Database accessibility
- App URL reachability

Output should be clean and actionable.

## Auth UX Improvements

### Auth detection in discover

If auth is detected, prompt:

- "Run auth now? (Y/n)"
- If yes, launch `raiken auth` automatically

### SSO guidance

When SSO is detected, show a short checklist:

- Complete SSO in the browser window
- Confirm logged-in state
- Press Enter to save session state

## Discovery UX Improvements

### Summary output

After discovery, show a structured summary:

- Pages discovered
- Verified links
- Broken links
- Auth blockers
- Time elapsed

### Safe defaults

Default `excludePatterns` should include routes like:

```
/logout
/delete
/admin
/billing
/danger
```

These should be documented in the config template.

### Failure transparency

If discovery ends early, say why:

- Auth pause
- Max depth/pages reached
- Network errors

## Dashboard UX Improvements

### First-run tour

On first dashboard visit:

- Highlight discovery summary
- Show verified navigation paths
- Provide a "Generate a test" CTA

### Discovery view

Include:

- Verified navigation paths
- Working selectors
- Auth blockers
- Broken links

### Test generation transparency

Show which discovery artifacts were used in the test (paths/selectors).

## Docs Improvements

### Quickstart

Create a single 5-minute quickstart with these steps:

1) `raiken init`
2) `raiken auth`
3) `raiken discover`
4) `raiken start`

### Troubleshooting tree

Provide a decision tree for common issues:

- Auth failures
- Empty discovery results
- Missing selectors

## Telemetry (Optional)

If added, it should be:

- Opt-in only
- Local-first (no cloud requirement)
- Minimal data collection (command timings, errors)

## Open Questions

- Should `raiken init` run in non-interactive mode for CI?
- Should `raiken discover` default to a safe-crawl mode?
- Should CLI logs be more structured (JSON option)?

## Acceptance Criteria (for future implementation)

- First-time user can reach "discover" in under 5 minutes
- Auth guidance works for both password and SSO flows
- Dashboard shows discovery data without manual steps
- No ambiguous errors in the CLI output
