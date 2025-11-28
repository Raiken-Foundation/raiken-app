# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Raiken is a developer-centric CLI tool that automates generation, execution, and repair of E2E tests. It maintains local state using SQLite to understand project evolution over time.

## Architecture

This is an Nx Integrated Monorepo with 4 main modules:

| Module | Location | Purpose | Tech Stack |
|--------|----------|---------|------------|
| CLI | `apps/cli` | Node.js binary, spawns server, orchestrates agent | Fastify, Commander |
| Dashboard | `apps/dashboard` | Visual interface, communicates via tRPC | React, Vite, Tailwind, TanStack Query |
| Core | `libs/core` | "Brain" - DB, AST parsing, Embeddings | SQLite-vec, Transformers.js, Babel |
| API | `libs/api` | Shared tRPC Router & Types | tRPC, Zod |
| Config | `libs/config` | Shared configuration | - |

**Data Flow:** CLI spawns Fastify server (port 7101) → Dashboard connects via tRPC → API calls Core → Core reads/writes to `.raiken/raiken.db`

**Import Aliases:**
- `@raiken/core` → `libs/core/src/index.ts`
- `@raiken/config` → `libs/config/src/index.ts`
- `@raiken/api` → `libs/api/src/index.ts`

## Common Commands

```bash
# Development
nx serve cli              # Run CLI backend (Fastify on port 7101)
nx serve dashboard        # Run React dashboard (Vite on port 4200)

# Building
nx build cli              # Build CLI (includes dashboard as static assets)
nx build dashboard        # Build dashboard only
nx build core             # Build core library
nx run-many -t build      # Build all projects

# Testing
nx test core              # Run core library tests
nx test core --watch      # Watch mode for core tests
nx test <project>         # Run tests for any project

# Linting & Formatting (uses Biome)
pnpm lint                 # Lint entire codebase
pnpm format               # Format entire codebase
pnpm check                # Run all Biome checks
nx lint <project>         # Lint specific project
```

## Development Workflow

During development, run two terminals:
1. `nx serve cli` - Backend on port 7101
2. `nx serve dashboard` - Frontend on port 4200 (proxies `/api` to 7101)

The `tools/playground` directory contains test files for integration testing.

## Code Style

- Biome for linting/formatting (not ESLint/Prettier for most checks)
- 4-space indentation
- Double quotes for JavaScript/TypeScript strings
- 100 character line width
