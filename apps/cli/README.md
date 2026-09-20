# Raiken

**AI-powered E2E test generation, execution, and repair.**

Raiken is a developer-centric CLI tool that uses AI to automatically generate, run, and fix Playwright end-to-end tests. It understands your codebase through semantic analysis and generates tests with accurate selectors from your live application.

[![npm version](https://img.shields.io/npm/v/raiken.svg)](https://www.npmjs.com/package/raiken)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## Features

- **Natural Language Test Generation** — Describe what you want to test, get working Playwright code
- **Smart Codebase Understanding** — AST parsing + embeddings understand your app structure
- **Live DOM Capture** — Captures real page elements for accurate, stable selectors
- **Visual Dashboard** — Modern UI for generating, viewing, and managing tests
- **Self-Monitoring Tests** — Automatically detects stale tests and suggests repairs

---

## Installation

```bash
npm install -g raiken
```

Requires **Node.js 22 or newer** (22 LTS or 24 LTS both work; prebuilt native modules are included for each).

Installing with `pnpm add -g` instead needs one extra step. pnpm blocks dependency
build scripts by default, which leaves the native modules behind `better-sqlite3`
(the database) and `sharp` (the embeddings model) unbuilt, so commands fail at
runtime with `Cannot find module '../build/Release/...'`. Approve them once:

```bash
pnpm approve-builds -g
```

---

## Quick Start

### 1. Initialize in your project

```bash
cd your-project
raiken init
```

This creates a `raiken.config.json` and sets up the test directory.

### 2. Configure an AI provider

The quickest safe setup is the interactive wizard. It lets you choose a provider, enter a key
without echoing it, pick a model, and saves the result for both the CLI and dashboard:

```bash
raiken config
```

Raiken supports OpenRouter, OpenAI, Anthropic, Google, Groq, Mistral, DeepSeek, xAI, Together,
Perplexity, Ollama, and custom OpenAI-compatible endpoints. Ollama does not require an API key.

For automation or CI, use the selected provider's environment variable instead. For example:

```bash
OPENROUTER_API_KEY=sk-or-v1-your-key-here
```

Put it in your shell environment or a project-local `.env` file. Environment keys take precedence
over a saved local key, so one CI secret can safely override a developer's local configuration.

Useful non-interactive forms:

```bash
raiken config deepseek                           # switch to DeepSeek and its defaults
raiken config --provider anthropic --model claude-sonnet-4-5
raiken config --list                             # show active provider, model, and key source
raiken config --unset-key                        # remove only the saved local key
```

Avoid passing `--api-key` in regular use: command-line arguments may be retained in shell history
or visible to other local processes. Use `raiken config` or an environment variable instead.

The wizard and dashboard share `raiken.config.json`, which `raiken init` adds to `.gitignore`.
Never commit this file when it contains a key.
Raiken remembers local keys per provider, so changing from OpenAI to DeepSeek and back does not
require entering the OpenAI key again.

### 3. Start the dashboard

```bash
raiken start
```

Open **http://localhost:7101** in your browser.

### 4. Generate your first test

In the dashboard chat, describe what you want to test:

> "Test the login flow at localhost:3000 - enter email and password, click submit, verify redirect to dashboard"

Raiken will:
1. Analyze your codebase for context
2. Capture the live DOM from your running app
3. Generate a Playwright test with real selectors
4. Save it to your test directory

---

## Commands

Every command supports `--help`. Scripting contract: `--json` output is machine-clean on
stdout (diagnostics go to stderr), and exit codes are `0` success, `1` runtime/test failure,
`2` usage error, `3` config/auth error, `4` busy conflict, `130` cancelled.

### Interactive agent & sessions

| Command | Description |
|---------|-------------|
| `raiken` | Interactive chat REPL (slash commands: `/test`, `/repair`, `/report`, `/doctor`, `/ci`, `/cover`, `/sessions`, …) |
| `raiken -p "test the login flow"` | One-shot agent request (`--json`, `--stream-json`, `--run`, `--no-save`, `--headed`, `--timeout <ms>`, `--allow-ungrounded`) |
| `raiken sessions` | List saved sessions (`--json`) |
| `raiken resume [name]` | Resume a saved session (latest if omitted) |

### Setup

| Command | Description |
|---------|-------------|
| `raiken init` | Initialize Raiken in your project (`-f`, `-y`, `--skip-browsers`) |
| `raiken config` | Set the AI provider, key, model, and endpoint (interactive wizard, or via flags) |
| `raiken start` | Start the server and dashboard on port 7101 (`-p <port>`, `--remote`) |

### Running & repairing tests

| Command | Description |
|---------|-------------|
| `raiken test [file]` | Run the Playwright suite or one spec; exit code = pass/fail |
| `raiken test --grep <p>` | Only tests whose title matches |
| `raiken test --headed` / `--debug` | Visible browser / Playwright inspector |
| `raiken test --workers <n>` `--project <name>` `--retries <n>` `--update-snapshots` | Playwright execution controls |
| `raiken test --list` | List tests without running them |
| `raiken test --watch` | Re-run on every project change until Ctrl+C |
| `raiken test --only-flaky` | Run only quarantined specs |
| `raiken test --fix` | After a failure, run the AI repair flow |
| `raiken test --allow-unverified` | Run specs carrying the `@raiken-unverified` marker (default: refuse, exit 1) |
| `raiken repair [file]` | AI-repair a failing spec: runs it, shows the fix as a diff, writes after confirmation (`--apply`, `--json`, `--no-interpret`) |
| `raiken report [file]` | HTML/Markdown/JSON report with screenshots (`--from`, `--format`, `--output`, `--open`) |
| `raiken show-trace [path]` | Open a Playwright trace.zip in the trace viewer (newest when omitted) |
| `raiken cover <target>` | Draft a test from an AC reference, symbol, or free text (`-t`, `-o`, `--dir`, `--dry-run`, `--allow-ungrounded`, `--fix-config`, `--force`, `--verify`, `--json`) |
| `raiken doctor` | Environment checks (Playwright, browsers, webServer script, baseURL) + flake anti-pattern lint (`--dir`, `--fail-on`, `--fix`, `--json`) |
| `raiken eval <suite> [target]` | Eval harness: `playground`, `benchmark`, `flakiness <spec>` (`--runs`, `--expect-tests`, `--out`) |
| `raiken organize` | AI-assisted test-dir + config cleanup (`-y`, `--tests-only`, `--config-only`) |

### CI & change analysis

| Command | Description |
|---------|-------------|
| `raiken ci` | Impact analysis + affected tests + JUnit/JSON reports (`--base`, `--staged`, `--skip-run`, `--format`) |
| `raiken trace [stackTrace]` | Map a stack trace to the tests most likely to reproduce it |
| `raiken sync` | Sync with the ticket system and analyze test impact (`-t <id>`) |
| `raiken context` | Write `raiken.ctx.md`, a project snapshot for IDE AI agents |
| `raiken hooks install` / `uninstall` / `status` | Fail-soft git hooks that run raiken on commit/push |

### Project intelligence & discovery

| Command | Description |
|---------|-------------|
| `raiken status` | Project setup at a glance (`--json`) |
| `raiken index` | Build the code graph (`--embeddings`, `--force`) |
| `raiken search <query>` | Semantic code search (`--limit`, `--type`, `--json`) |
| `raiken discover [url]` | Autonomously discover web application structure (`--max-pages`, `--auth`, `--continue`, `--status`) |
| `raiken knowledge` (alias `kb`) | Inspect discovered pages, links, and blockers |
| `raiken memory` | What the agent has learned about this project (`show` / `clear`) |
| `raiken auth` | Log in, save the session, then crawl the app behind it (`--url`, `--script`, `--manual`, `--cookie`, `--write-login-script`, `--no-discover`) |

### The everyday test loop

```bash
# Cold start (app must already be running at Playwright baseURL)
raiken status                # missing site knowledge → discover hint
raiken doctor --fix           # widen a restrictive testMatch, etc.
raiken discover <url>        # or let cover auto-discover when seed URL is known
raiken auth --url <login>    # before post-login scenarios (crawls behind the login too)

raiken cover "login as admin and see the dashboard"
raiken test e2e/<draft>.spec.ts
raiken repair e2e/<draft>.spec.ts   # after a real failure (not "No tests found")

raiken test --watch          # inner loop: re-runs on every edit
raiken test --list           # what would run?
raiken test --fix            # failure → AI repair with diff review
raiken show-trace            # open the newest failure trace
```

`cover` / `-p` refuse or auto-discover when site knowledge is empty (unless
`--allow-ungrounded`).

Post-login scenarios need pages captured *with* a session, which a saved
`auth-state.json` does not provide on its own. `raiken auth` therefore crawls
the app once the session is saved (`--no-discover` skips it), and a post-login
`cover` re-crawls with the session if it finds one but no pages behind the
login. Until such pages exist, the draft is flagged as unverified after
sign-in — including when a session file is already present.

Drafts whose review is grounding-driven (locators nothing captured proves, or
post-login state no session-backed crawl saw) are stamped
`// @raiken-unverified`. `raiken test` refuses to run them (exit 1) so an
unverified draft cannot green-light CI — review the spec, remove the marker
once it is grounded, or pass `--allow-unverified` to run it anyway.

`raiken cover --verify` closes the loop at generation time: it runs the draft
against the app and drives the same bounded, auto-applied repair loop
`raiken repair` uses until the draft runs green — or it stops, reverts, and
reports honestly. Cover drafts are also grounded in the app's actual source
code (gathered the same way the interactive agent gathers it), so the model
derives structure from the code rather than guessing it from text snapshots.

A blocked draft (e.g. filename outside `testMatch`) points at
`raiken doctor --fix` / `--fix-config` instead of suggesting a doomed
`raiken test`.

Quarantining a flaky spec — add it to `raiken.config.json` and it is skipped by default:

```json
{ "quarantine": { "testFiles": ["e2e/legacy-checkout.spec.ts"] } }
```

Run only the quarantine list with `raiken test --only-flaky`.

---

## Configuration

Create `raiken.config.json` in your project root:

```json
{
  "testDirectory": "e2e",
  "baseUrl": "http://localhost:3000",
  "ai": {
    "model": "anthropic/claude-sonnet-4.5"
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `testDirectory` | string | `"e2e"` | Where to save generated tests |
| `baseUrl` | string | `"http://localhost:3000"` | Your app's development URL |
| `ai.provider` | string | `"openrouter"` | AI provider Raiken calls |
| `ai.model` | string | Provider default | Model identifier |
| `ai.apiKey` | string | — | Local fallback key; prefer the provider environment variable in CI |
| `ai.baseURL` | string | Provider default | Endpoint override for local/custom gateways |

### Supported AI Models

Any model available on [OpenRouter](https://openrouter.ai/models), including:

- `anthropic/claude-sonnet-4.5` (recommended)
- `anthropic/claude-opus-4`
- `openai/gpt-4o`
- `google/gemini-2.0-flash`
- `meta-llama/llama-3.3-70b`

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | Yes | Your OpenRouter API key |
| `OPENROUTER_MODEL` | No | Override the AI model |
| `OPENROUTER_BASE_URL` | No | Custom API endpoint |

---

## How It Works

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Your Codebase  │────▶│  Raiken Analyzer │────▶│  Code Graph DB  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                         │
┌─────────────────┐     ┌──────────────────┐             │
│  Your Running   │────▶│  DOM Capture     │             │
│  Application    │     │  (Playwright)    │             │
└─────────────────┘     └──────────────────┘             │
                                │                        │
                                ▼                        ▼
                       ┌──────────────────────────────────┐
                       │         AI Test Generator        │
                       │    (Claude/GPT-4 via OpenRouter) │
                       └──────────────────────────────────┘
                                        │
                                        ▼
                       ┌──────────────────────────────────┐
                       │     Generated Playwright Test    │
                       │         saved to e2e/            │
                       └──────────────────────────────────┘
```

1. **Codebase Analysis** — Raiken parses your source files, extracts functions, components, and routes, then creates embeddings for semantic search.

2. **DOM Capture** — When you describe a test, Raiken launches a headless browser, navigates to your app, and captures all interactive elements with their selectors.

3. **Context Assembly** — Relevant code snippets + live DOM elements are assembled into a rich context for the AI.

4. **Test Generation** — The AI generates a Playwright test using real selectors from your application.

5. **Test Execution** — Run generated tests with Playwright:
   ```bash
   npx playwright test
   ```

---

## Project Structure

After initialization, Raiken creates:

```
your-project/
├── raiken.config.json    # Configuration
├── .raiken/
│   └── raiken.db         # Local SQLite database (code graph, embeddings)
└── e2e/                  # Generated tests (configurable)
    └── login.spec.ts
```

---

## Running Generated Tests

Raiken generates standard Playwright tests. Run them with:

```bash
# Run all tests
npx playwright test

# Run specific test
npx playwright test e2e/login.spec.ts

# Run with UI
npx playwright test --ui
```

If you don't have Playwright installed:

```bash
npm init playwright@latest
```

---

## Troubleshooting

### "OPENROUTER_API_KEY not configured"

Set your API key:
```bash
export OPENROUTER_API_KEY=sk-or-v1-xxxxx
```

Or add it to `.env` in your project root:
```
OPENROUTER_API_KEY=sk-or-v1-xxxxx
```

### Dashboard not loading

Make sure port 7101 is available, or use a different port:
```bash
raiken start -p 8080
```

### DOM capture fails

Ensure your application is running at the URL you specify in your test prompt (e.g., "test login at localhost:3000").

---

## License

MIT © [Raiken Foundation](https://github.com/Raiken-Foundation)

---

## Links

- [GitHub Repository](https://github.com/Raiken-Foundation/raiken-app)
- [Report Issues](https://github.com/Raiken-Foundation/raiken-app/issues)
- [OpenRouter API](https://openrouter.ai)
