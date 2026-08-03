# Raiken Playground — Atlas Tracker

A small but realistic React + Vite project tracker, used as a test bed for
Raiken. The app intentionally exercises patterns Raiken cares about:
asynchronous data, role-based permissions, modal forms, paginated tables,
task comments, project membership changes, archived-record invariants, toasts,
and a real Playwright suite.

## What's inside

| Surface                       | Notes                                                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/`                    | Mock API with realistic latency and an opt-in failure rate. Every error throws from this file so `raiken trace` resolves to a real frame. |
| `src/contexts/`               | `AuthProvider` (with admin/member roles, persisted to `localStorage`) and `ToastProvider`.                                                |
| `src/pages/`                  | Home, Login, Dashboard, ProjectsList, ProjectDetail (tabs), Activity, Profile, Settings, About, Contact, NotFound.                        |
| `src/components/`             | Modal, ConfirmDialog, Toaster, Tabs, Pagination, StatusPill, Avatar, Navbar.                                                              |
| `e2e/`                        | Playwright suite covering authenticated task, comment, membership, archive, and permission workflows.                                     |
| `e2e/_flaky-examples.spec.ts` | **Intentionally bad.** Used to verify `raiken doctor` finds the common anti-patterns.                                                     |

## Demo accounts

| Username                    | Role   | Notes                                                |
| --------------------------- | ------ | ---------------------------------------------------- |
| `admin`                     | admin  | Can create projects, archive projects, delete tasks. |
| `amelia`, `jordan`, `priya` | member | Can browse, create tasks, change task status.        |
| Any other username          | member | Auto-provisioned on first login.                     |

Password is anything ≥ 4 characters. The mock API resets to seed data on
every page load and can also be reset from the **Settings → Danger zone**
panel.

## Common commands

```bash
# Dev server
pnpm --filter @raiken/playground dev          # http://localhost:3000

# Production build + preview
pnpm --filter @raiken/playground build
pnpm --filter @raiken/playground preview

# E2E tests (Playwright builds and auto-starts Vite preview on :5180)
pnpm --filter @raiken/playground test:e2e
pnpm --filter @raiken/playground test:e2e:ui      # interactive runner
pnpm --filter @raiken/playground test:e2e:headed  # see the browser

# Run a single suite
pnpm --filter @raiken/playground exec playwright test e2e/auth.spec.ts
```

## Exercising Raiken

After installing / linking the CLI (`pnpm run cli:install` from the monorepo,
or a global `raiken`):

```bash
cd tools/playground

# 1. Start the app the Playwright config points at (baseURL :5180).
#    Cover/discover need the app up — they do not start webServer themselves.
pnpm exec vite --host 127.0.0.1 --port 5180

# 2. In another terminal — cold-start ritual:
raiken status                 # shows missing site knowledge clearly
raiken doctor                 # flags narrow testMatch / env footguns
raiken doctor --fix            # one-shot widen testMatch → **/*.spec.ts

# Required for post-login flows — auth crawls behind the login once saved,
# so there is no separate discover step to remember:
raiken auth --url http://127.0.0.1:5180/login

# 3. Draft, run, repair
raiken cover "about page shows the heading"
raiken test e2e/<written-spec>.spec.ts
raiken repair e2e/<written-spec>.spec.ts   # after a real failure

# Dashboard (Quality → doctor / cover / discovery)
raiken start    # http://localhost:7101
```

Notes for first-time users:

- This playground ships with `testMatch: ["workflows.spec.ts"]`. Prefer
  `raiken doctor --fix` (or `raiken cover … --fix-config`) before expecting
  arbitrary `*.spec.ts` drafts to run.
- Only `/`, `/about`, `/contact` and `/login` are reachable signed out. Draft an
  auth scenario without running `raiken auth` and cover has never seen
  `/dashboard`, so it guesses from the signed-out home page — it will say so and
  name the command that fixes it.
- `raiken test` on a missing / uncollected file exits non-zero and does **not**
  suggest repair — that is a config problem, not a broken assertion.

Also useful:

```bash
raiken context                # portable project snapshot for IDE agents
raiken doctor                 # flake anti-patterns (see e2e/_flaky-examples.spec.ts)
raiken trace "at createTask (src/api/client.ts:213)"
```

## Tweaking the mock backend at runtime

The mock API is reactive to two `window` settings, useful for ad-hoc
testing in the browser console:

```js
window.__playgroundFailureRate = 0.25; // 25% of API calls fail
window.__playgroundLatency = { min: 600, max: 1500 }; // simulate slow network
```

These reset on refresh.
