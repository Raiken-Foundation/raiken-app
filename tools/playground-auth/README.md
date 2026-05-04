# playground-auth

A realistic test fixture for **Issue 4** — `raiken discover` hitting an
auth-walled SPA. It is a full **Vite + React SPA** whose Vite dev-server plugin
simulates **NextAuth `middleware.ts`**: every request that lacks a session cookie
receives a bare HTTP 302 → `/auth/login` before any HTML is emitted.

Once authenticated, the app exposes **six interlinked pages** — exactly the
kind of page graph `raiken discover` should find after handling auth.

---

## Auth middleware behaviour

| Request | Condition | Response |
|---------|-----------|----------|
| Any page route (`/`, `/dashboard`, …) | No session cookie | `302 → /auth/login` |
| `/auth/login`, `/auth/error`, `/auth/verify-request` | Always | `200` — login form |
| `/auth/callback/credentials` POST | Always | `302 → /dashboard` + sets `raiken-session` cookie |
| `/auth/signout` | Always | `302 → /auth/login` + clears cookie |
| Any URL with a file extension (JS, CSS, assets) | Always | Passed through to Vite |

Any username ≥ 3 chars and password ≥ 4 chars are accepted — this is a demo.

---

## Pages (discoverable after auth)

| Route | `data-testid` | Links to |
|-------|--------------|----------|
| `/auth/login` | `login-page`, `login-form` | — |
| `/dashboard` | `dashboard-page` | `/projects`, `/tasks`, all nav links |
| `/projects` | `projects-page` | `/projects/:id` per row |
| `/projects/:id` | `project-detail-page` | `/projects` (breadcrumb) |
| `/tasks` | `tasks-page` | — |
| `/members` | `members-page` | — |
| `/settings` | `settings-page` | — |

Sidebar navigation is present on every protected page, giving the crawler
sufficient link density to build a complete page graph.

---

## Start

```bash
# Install once
npm install

# Dev server (port 5100)
npm run dev
```

The server is also started automatically by the Playwright spec in
`tools/playground/e2e/discovery-auth-wall.spec.ts`.

---

## Why this matters for Issue 4

`raiken discover` needs two distinct code paths:

1. **Rendered login form detected** (current behaviour, works) — the crawler
   follows the 302 to `/auth/login`, waits for React to render, finds the
   `<form>` in the DOM, and emits `🛑 Authentication required`.

2. **Bare 302 loop / no rendered form** (gap in Issue 4) — when the auth
   redirect target itself returns no renderable HTML (e.g. a server-side
   session check that bounces `/auth/login` too), the crawler finishes with
   `0 requests` and no auth signal. This is the "No pages discovered" fallback
   described in the bug report. `server.mjs` in this directory reproduces that
   narrower case.

The Playwright spec covers both layers plus a complete post-auth page
discovery harness so you can confirm the full page graph is reachable once
auth is handled.
