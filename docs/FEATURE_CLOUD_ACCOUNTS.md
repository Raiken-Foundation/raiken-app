# Feature: Cloud Accounts and Test Storage

> **Status:** Deferred (as of Feb 2026)
> **Priority:** Out of scope for current phase
> **Complexity:** High
> **Dependencies:** Auth provider, cloud storage, sync engine, billing
>
> **Why deferred:** This feature pushes Raiken toward a cloud/SaaS platform, which dilutes the local-first wedge that differentiates us from Meticulous, QA Wolf, Octomind, and Checkly. See `ROADMAP.md` → Deferred. Revisit only after P0 + P1 items have shipped and there is explicit user demand for cross-device sync.
>
> **Related:** `FEATURE_BUSINESS_CONTEXT_INTEGRATION.md` originally depended on this for developer-scoped ticket fetching. That dependency has been rescoped — the already-shipped Jira/GitHub/Linear ticket sync works from local git config + PATs, no account required.

---

## Executive Summary

Allow developers to create Raiken accounts so they can persist tests, discovery data, agent conversations, and project configurations in the cloud. This enables cross-device access, team collaboration, and a foundation for future paid tiers.

---

## Problem Statement

### Current Limitation

Everything Raiken produces lives on a single machine:

- Generated tests exist only as local files
- Discovery data is stored in a local SQLite database (`.raiken/raiken.db`)
- Chat history with the AI agent is lost on server restart
- Switching machines means starting from scratch
- No way for teams to share a project's testing baseline

### Impact

- Developers lose work when switching devices or wiping environments
- Teams cannot share discovered site knowledge or generated tests
- No continuity between CI and local development
- No path to a sustainable business model without accounts

---

## Solution Overview

Introduce optional Raiken accounts that sync local project data to the cloud. The CLI and dashboard remain local-first — the cloud layer is additive, not required.

### Core Principles

| Principle | Description |
|-----------|-------------|
| **Local-first** | Everything works offline. Cloud sync is optional and additive. |
| **Own your data** | Users can export everything at any time. Local files are never removed. |
| **Selective sync** | Users choose what to sync: tests, discovery, conversations, config. |
| **Team-aware** | Projects can be shared with team members via org accounts. |
| **Privacy-safe** | Source code is never uploaded. Only test files, metadata, and agent conversations sync. |

---

## What Gets Stored

### Per-User

| Data | Storage | Purpose |
|------|---------|---------|
| Account profile | Cloud DB | Email, name, avatar, plan tier |
| API keys (encrypted) | Cloud DB | OpenRouter key, stored encrypted at rest |
| Linked identities | Cloud DB | GitHub username, Jira email/account ID (used by Business Context Integration to scope tickets and PRs to this developer) |
| Preferences | Cloud DB | Default model, autonomy settings, theme |
| Usage metrics | Cloud DB | Token usage, test runs, discovery sessions |

### Per-Project

| Data | Sync | Purpose |
|------|------|---------|
| Generated test files | Yes | Persist and share `.spec.ts` files |
| Discovery snapshots | Yes | Site knowledge, discovered pages, links, blockers |
| Agent conversations | Yes | Full chat history with the AI agent |
| Test run results | Yes | Pass/fail history, AI interpretations |
| `raiken.config.json` | Yes | Project configuration |
| Code graph metadata | Optional | File list, keywords, module structure (no source code) |
| Source code | **Never** | Source code never leaves the developer's machine |

---

## Account Tiers

| Tier | Price | Includes |
|------|-------|----------|
| **Free** | $0 | 1 project, 50 saved tests, 30-day history, BYO API key |
| **Pro** | TBD/month | Unlimited projects, unlimited tests, full history, priority models, team sharing (up to 5) |
| **Team** | TBD/month | Everything in Pro + org management, role-based access, audit log, SSO |

---

## Authentication

### Supported Methods

- Email + password
- GitHub OAuth
- Google OAuth

### CLI Flow

```
$ raiken login

  Raiken — Log in to your account

  ? How would you like to log in?
    > GitHub
      Google
      Email + password

  Opening browser for GitHub authentication...

  ✅ Logged in as developer@example.com
  Session saved to ~/.raiken/session.json
```

### Dashboard Flow

- Login button in the header (top right)
- OAuth redirect flow
- Session persisted in browser + synced to CLI via shared token

### Token Storage

- CLI: `~/.raiken/session.json` (user home, not project dir)
- Dashboard: `httpOnly` cookie or `localStorage` with refresh token
- Tokens expire after 30 days of inactivity

---

## Sync Engine

### How Sync Works

1. Developer generates a test or runs discovery locally
2. Data is written to local SQLite as before
3. If logged in and sync is enabled, a background process pushes changes to the cloud
4. On another device, `raiken pull` fetches the latest state
5. Conflicts are resolved with last-write-wins for tests, merge for discovery data

### CLI Commands

| Command | Description |
|---------|-------------|
| `raiken login` | Authenticate and save session |
| `raiken logout` | Clear session |
| `raiken push` | Push local changes to cloud |
| `raiken pull` | Pull latest from cloud |
| `raiken sync` | Two-way sync (push + pull) |
| `raiken status --cloud` | Show sync status and drift |

### Sync Granularity

```json
// raiken.config.json
{
  "cloud": {
    "enabled": true,
    "sync": {
      "tests": true,
      "discovery": true,
      "conversations": true,
      "results": true,
      "config": true,
      "codeGraph": false
    },
    "autoSync": false
  }
}
```

---

## Team Collaboration

### Shared Projects

- Project owner invites team members by email
- Members see shared tests, discovery data, and conversation history
- Members can generate and push their own tests

### Roles

| Role | Permissions |
|------|------------|
| **Owner** | Full access, manage members, delete project |
| **Editor** | Generate, edit, delete tests. Run discovery. |
| **Viewer** | Read-only access to tests, results, and discovery |

### Conflict Resolution

- Tests: last-write-wins with version history (rollback available)
- Discovery: merge (union of discovered pages)
- Config: owner's config takes precedence

---

## API Design (Draft)

### Endpoints

```
POST   /api/auth/login
POST   /api/auth/logout
POST   /api/auth/refresh

GET    /api/projects
POST   /api/projects
GET    /api/projects/:id

POST   /api/projects/:id/sync/push
POST   /api/projects/:id/sync/pull
GET    /api/projects/:id/sync/status

GET    /api/projects/:id/tests
POST   /api/projects/:id/tests
DELETE /api/projects/:id/tests/:testId

GET    /api/projects/:id/discovery
GET    /api/projects/:id/conversations
GET    /api/projects/:id/results

POST   /api/projects/:id/members
DELETE /api/projects/:id/members/:userId

GET    /api/usage
```

### Data Format

All synced data uses JSON. Test files are stored as content strings with metadata:

```json
{
  "id": "test_abc123",
  "fileName": "login.spec.ts",
  "content": "import { test, expect } from '@playwright/test';\n...",
  "createdAt": "2026-02-21T12:00:00Z",
  "updatedAt": "2026-02-21T14:30:00Z",
  "createdBy": "user_xyz",
  "lastRunStatus": "passed",
  "tags": ["auth", "login"]
}
```

---

## Dashboard Changes

### Header

- Add login/signup button (top right)
- Show user avatar and plan badge when logged in
- Add sync indicator (synced / pending / offline)

### Settings View

- Add "Account" section: profile, plan, usage
- Add "Team" section: members, invitations, roles
- Add "Sync" section: toggle per data type, manual push/pull

### Test Files

- Show sync status per file (local only / synced / conflict)
- Show who last edited a test (for team projects)
- Show version history with diff view

---

## Infrastructure Requirements

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Auth | Supabase Auth or Auth0 | OAuth, email/password, session management |
| API | Fastify or Hono on Cloudflare Workers | Sync endpoints, project management |
| Database | Supabase Postgres or PlanetScale | User data, project metadata, test storage |
| File storage | S3 or R2 | Large discovery snapshots, attachments |
| Queue | Inngest or BullMQ | Background sync jobs |

---

## Privacy and Security

- Source code is **never** uploaded — only test files and metadata
- API keys are encrypted at rest (AES-256)
- All sync traffic uses HTTPS
- Users can delete their account and all data at any time
- SOC 2 compliance planned for Team tier
- Data residency options for EU customers (future)

---

## Migration Path

### From Local-Only to Cloud

1. User creates account (`raiken login`)
2. User runs `raiken push` to upload existing project
3. Local workflow is unchanged — cloud is additive
4. User can `raiken logout` at any time to return to local-only

### From Free to Pro

- No data migration needed
- Limits are lifted immediately on upgrade
- Historical data (beyond 30 days) becomes accessible

---

## Open Questions

1. Should auto-sync be opt-in or opt-out for logged-in users?
2. Should the free tier include team sharing (read-only)?
3. Should we support self-hosted cloud backends for enterprise?
4. How should we handle large discovery datasets (>1000 pages)?
5. Should test version history be git-based or custom?
6. Should the cloud API be public for third-party integrations?
