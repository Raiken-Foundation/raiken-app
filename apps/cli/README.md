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

Requires **Node.js 22.x** (see the workspace `.nvmrc`)

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

| Command | Description |
|---------|-------------|
| `raiken init` | Initialize Raiken in your project |
| `raiken config` | Set the AI provider, key, model, and endpoint (interactive wizard, or via flags) |
| `raiken start` | Start the server and dashboard on port 7101 |
| `raiken start -p 8080` | Start on a custom port |

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
