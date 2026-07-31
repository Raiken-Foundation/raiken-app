# Runtime model

Raiken ships as an **embedded monolith**: one local process per user project, not a hosted multi-tenant service.

## Process layout

When a developer runs `raiken` in a project directory, the CLI starts a single **Fastify** server (default port `7101`) in that same process tree. The server exposes the tRPC API from `@raiken/shared/server` and serves the dashboard as static assets bundled into the CLI build.

During local development, the dashboard runs as a separate Vite dev server (`4200`) that proxies `/api` to the CLI backend. Production and installed CLI builds embed the prebuilt dashboard under the CLI artifact’s `public/` directory.

## State and scope

All durable Raiken state lives **inside the target project** under `.raiken/` (SQLite database, auth storage, traces, chat history, etc.). There is no shared cloud database or cross-project runtime coupling.

Each invocation is scoped to one `projectPath`. The CLI, dashboard, and tRPC layer all operate on that path; switching projects means pointing Raiken at a different directory.

## Dependency direction

The monorepo intentionally keeps a narrow dependency graph:

| Layer | Depends on |
|-------|------------|
| Dashboard (`apps/dashboard`) | Browser-safe `@raiken/shared` |
| CLI (`apps/cli`) | `@raiken/shared/server`, `@raiken/core` application services |
| Shared browser entry | Browser-safe transport types and pure helpers only |
| Shared server entry | `@raiken/core` application services and the tRPC router |
| Core (`libs/core`) | External libraries only (no app imports) |

`tRPC` is the transport contract between dashboard and backend. CLI commands call the same project-scoped core application services directly; they do not route production work through `appRouter.createCaller`. Router parity tests guard the two adapters against semantic drift.

## Runtime compatibility contracts

- Raiken 0.6 requires Node.js `>=22 <23`. The root and published CLI `engines` fields, `.nvmrc`, documentation, and CI use the same major.
- Browser code imports `@raiken/shared`; Node hosts import `@raiken/shared/server`. Moving server/router exports out of the browser entry prevents Crawlee, native SQLite, and other Node-only dependencies from entering the dashboard bundle.
- CLI exits are stable: `0` success, `1` runtime/test failure, `2` usage/validation, `3` config/auth, `4` busy/conflict, `124` timeout, and `130` cancellation.
- `getHealth` preserves `engine` and `version`, and adds `status`, `liveness`, `readiness`, and component checks. Callers must handle `ok`, `degraded`, and `not_ready`.
- HTTP errors retain the legacy `error` and `detail` strings while exposing redacted structured metadata under `raiken`. tRPC errors carry the same code/category/retry metadata.

## Fixtures

Integration and E2E fixtures under `tools/` (for example `tools/playground` and `tools/playground-auth`) are standalone sample apps. They are tagged `scope:playground` and are not part of the shipped CLI runtime; they exist to exercise Raiken against deterministic test targets.
