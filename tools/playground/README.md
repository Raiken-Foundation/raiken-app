# Raiken Playground — Atlas Tracker

A small but realistic React + Vite project tracker, used as a test bed for
Raiken. The app intentionally exercises patterns Raiken cares about:
asynchronous data, role-based permissions, modal forms, paginated tables,
toasts, and a real Playwright suite.

## What's inside

| Surface | Notes |
|--------|-------|
| `src/api/` | Mock API with realistic latency and an opt-in failure rate. Every error throws from this file so `raiken trace` resolves to a real frame. |
| `src/contexts/` | `AuthProvider` (with admin/member roles, persisted to `localStorage`) and `ToastProvider`. |
| `src/pages/` | Home, Login, Dashboard, ProjectsList, ProjectDetail (tabs), Activity, Profile, Settings, About, Contact, NotFound. |
| `src/components/` | Modal, ConfirmDialog, Toaster, Tabs, Pagination, StatusPill, Avatar, Navbar. |
| `e2e/` | Playwright suite: `auth`, `projects`, `tasks`, `permissions`, `dashboard`. |
| `e2e/_flaky-examples.spec.ts` | **Intentionally bad.** Used to verify `raiken doctor` finds the common anti-patterns. |

## Demo accounts

| Username | Role | Notes |
|---------|------|-------|
| `admin` | admin | Can create projects, archive projects, delete tasks. |
| `amelia`, `jordan`, `priya` | member | Can browse, create tasks, change task status. |
| Any other username | member | Auto-provisioned on first login. |

Password is anything ≥ 4 characters. The mock API resets to seed data on
every page load and can also be reset from the **Settings → Danger zone**
panel.

## Common commands

```bash
# Dev server
pnpm --filter @raiken/playground dev          # http://localhost:5173

# Production build + preview
pnpm --filter @raiken/playground build
pnpm --filter @raiken/playground preview

# E2E tests (Playwright auto-starts vite preview on :5180)
pnpm --filter @raiken/playground test:e2e
pnpm --filter @raiken/playground test:e2e:ui      # interactive runner
pnpm --filter @raiken/playground test:e2e:headed  # see the browser

# Run a single suite
pnpm --filter @raiken/playground exec playwright test e2e/auth.spec.ts
```

## Exercising Raiken

After installing the global `raiken` CLI:

```bash
cd tools/playground

# Sanity-check the codebase (impact section is on by default;
# pass --no-impact to skip the pending-changes / affected-tests block)
raiken context

# Scan the e2e suite for anti-patterns (the _flaky file is a fixture)
raiken doctor

# Find tests that cover a stack frame
raiken trace "at createTask (src/api/client.ts:213)"

# Dashboard
raiken start    # http://localhost:7101 → Quality view
```

## Tweaking the mock backend at runtime

The mock API is reactive to two `window` settings, useful for ad-hoc
testing in the browser console:

```js
window.__playgroundFailureRate = 0.25  // 25% of API calls fail
window.__playgroundLatency = { min: 600, max: 1500 }  // simulate slow network
```

These reset on refresh.
