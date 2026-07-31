# playground-auth

A deterministic **Vite + React SPA** fixture for auth-wall discovery, role gates,
MFA, session expiry, and UI interruptions. The Vite dev-server plugin simulates
**NextAuth `middleware.ts`**: unauthenticated page routes receive HTTP `302 →
/auth/login` before HTML is served. Credentials, MFA codes, and session TTLs are
fixed — this is a benchmark fixture, not production auth.

The standalone `server.mjs` target keeps minimal redirect-only behaviour for
`raiken eval playground` (no sessions, no post-login SPA).

---

## Deterministic users

All accounts use password **`password`** unless noted.

| Username | Role | Permissions | Notes |
|----------|------|-------------|-------|
| `admin` | admin | manage workspace, projects, members | Full access |
| `member` | member | edit projects | No members/settings destructive actions |
| `viewer` | viewer | read projects (read-only) | Create project disabled |
| `mfa-admin` | admin | manage workspace, projects, members | MFA required after password |
| `locked` | member | — | Login rejected as locked |
| `expiring` | admin | manage workspace, projects, members | Session TTL ~1.75s |

**MFA code (fixture):** `123456` (user `mfa-admin` only)

---

## Auth middleware behaviour (Vite plugin)

| Request | Condition | Response |
|---------|-----------|----------|
| Protected page route | No / expired session | `302 → /auth/login` (adds `?reason=expired` when expired) |
| `/auth/login`, `/auth/mfa`, `/auth/error`, … | Always | `200` — React pages |
| `POST /auth/callback/credentials` | Valid credentials | `302` + session cookie, or `302 → /auth/mfa` if MFA pending |
| `POST /auth/callback/credentials` | Invalid / locked | `401` / `403` JSON `{ error, message }` |
| `POST /auth/callback/mfa` | Valid code `123456` | `302 → /dashboard` + session cookie |
| `POST /auth/callback/mfa` | Wrong code | `401` JSON |
| `GET /auth/session` | Valid session | `200` JSON `{ user, name, role, permissions, exp }` |
| `POST /auth/reauth` | Valid password for current user | `200` + short-lived reauth proof cookie |
| `POST /api/workspace/delete` | Admin + recent reauth proof | `200` simulated delete JSON |
| `GET /auth/signout` | Always | `302 → /auth/login` + clears cookies |
| Static assets / Vite internals | Always | Passed through |

Session cookie: HttpOnly, SameSite=Lax, base64 JSON payload with expiry validated
on every protected request and `/auth/session`.

---

## UI interruptions (golden flows)

| Interruption | Trigger | Persistence | `data-testid` |
|--------------|---------|-------------|---------------|
| Cookie consent | First visit | `localStorage` (`playground-auth-cookie-consent`) | `cookie-consent-banner`, `cookie-consent-accept`, `cookie-consent-decline` |
| Welcome modal | After first login per browser session | `sessionStorage` | `welcome-modal`, `welcome-modal-dismiss` |
| Unsaved settings | Navigate away with dirty Settings form | — | `unsaved-changes-dialog` (Stay / Discard) |
| Delete workspace | Admin → Settings danger zone | — | `delete-workspace-dialog` → `reauth-dialog` → `workspace-delete-success` |

Cookie banner is fixed to the bottom and does not cover the login form.

---

## Pages (discoverable after auth)

| Route | `data-testid` | Role notes |
|-------|--------------|------------|
| `/auth/login` | `login-page`, `login-form` | Credential hints listed |
| `/auth/mfa` | `mfa-page`, `mfa-form` | After `mfa-admin` login |
| `/dashboard` | `dashboard-page` | Welcome modal on first session login |
| `/projects` | `projects-page` | `open-create-project` disabled for viewer |
| `/projects/:id` | `project-detail-page` | — |
| `/tasks` | `tasks-page` | — |
| `/members` | `members-page` | Table hidden for non-admin |
| `/settings` | `settings-page` | Danger zone admin-only |

---

## Commands

```bash
# Full SPA with auth middleware on :5100
pnpm exec nx run @raiken/playground-auth:serve

# Type-check and production build
pnpm exec nx run @raiken/playground-auth:typecheck
pnpm exec nx run @raiken/playground-auth:build

# Golden Playwright suite (starts Vite automatically)
pnpm exec nx run @raiken/playground-auth:test:e2e

# Exercise Raiken's configured custom-login script
RAIKEN_PLAYGROUND_AUTH_USER=admin \
RAIKEN_PLAYGROUND_AUTH_PASSWORD=password \
pnpm exec raiken auth

# AI-backed features (eval, agent) resolve the provider key from the
# environment — export it yourself, never commit one to raiken.config.json:
export DEEPSEEK_API_KEY=sk-…

# Minimal redirect-only wall (eval fixture, no SPA sessions)
pnpm exec nx run @raiken/playground-auth:auth-wall
```

---

## Golden Playwright coverage

`tests/auth-flow.spec.ts` covers:

1. Unauthenticated redirect to login wall
2. Invalid credentials JSON error
3. Locked account rejection
4. Admin login, navigation, logout
5. MFA wrong code then correct `123456`
6. Viewer project-create denial
7. Cookie consent + welcome modal
8. Unsaved settings Stay / Discard
9. Destructive delete confirm + wrong/right reauth
10. Expiring session redirect with expired banner

Helpers live in `tests/helpers.ts`.

---

## Why this matters for Issue 4

`raiken discover` needs two distinct code paths:

1. **Rendered login form detected** — crawler follows `302 → /auth/login`, finds
   the form, emits an auth-blocker handoff.
2. **Bare 302 loop / no rendered form** — `server.mjs` reproduces the narrower
   detection-only case for eval.

This fixture adds deterministic post-auth flows (roles, MFA, expiry, UI
interruptions) so generated and golden tests can exercise realistic auth SPA
behaviour without external dependencies.
