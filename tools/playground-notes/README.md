# playground-notes

A deterministic **Vite + React SPA** notes fixture ("Scrawl") for Raiken
discovery and grounded-draft testing. Public — no auth wall, no server: all
data lives in an in-memory store seeded on load.

---

## Pages

| Route | `data-testid` | Notes |
|-------|--------------|-------|
| `/` | `notes-page` | Search + tag filter over seeded notes |
| `/note/:slug` | `note-detail-*` | Read, pin/unpin, delete (two-step confirm) |
| `/note/:slug/edit` | `edit-note-page` | Title/body/tag editing with validation |
| `/new` | `new-note-page` | Create note (title + body required) |
| `/about` | `about-page` | Static page |
| `/login` | `login-page` | Fixture login — any credentials succeed |
| `/archive` | `archive-page` | **Deliberately unlinked**: exists as a route, nothing links to it |
| `*` | `not-found-page` | Unknown routes |

Every page sets `document.title`, so discovery records titles for all of them.

---

## Seeded notes

Fixed slugs so hand-written and generated tests agree:

- `welcome-to-scrawl` (pinned, personal)
- `roadmap-notes` (pinned, work)
- `book-recommendations` (ideas)
- `meeting-agenda` (work)
- `research-links` (research)
- `grocery-list` (personal)

---

## Commands

```bash
# Dev server on :3001
pnpm exec nx run @raiken/playground-notes:serve

# Type-check and production build
pnpm exec nx run @raiken/playground-notes:typecheck
pnpm exec nx run @raiken/playground-notes:build

# Hand-written smoke suite (starts the built app automatically on :5182)
pnpm exec nx run @raiken/playground-notes:test:e2e
```

---

## Why this fixture exists

`raiken eval playground` crawls the built SPA and verifies:

1. The link-reachable public route graph is discovered (`/`, `/about`).
2. `/login` surfaces as a page (it is public, so no auth blocker is emitted).
3. Every discovered page has a title.
4. The unlinked `/archive` route is not discovered through links.
