# Autonomous DOM Traversal (Site Discovery)

Raiken can autonomously discover your web application's structure by crawling pages, detecting authentication requirements, and mapping navigation paths. This discovered knowledge is automatically integrated into test generation to produce more accurate, realistic E2E tests.

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Commands](#commands)
- [Configuration](#configuration)
- [How It Works](#how-it-works)
- [Authentication Handling](#authentication-handling)
- [Advanced Usage](#advanced-usage)
- [Troubleshooting](#troubleshooting)

## Overview

**Problem:** Most web applications require multi-page navigation flows (login → dashboard → settings → action). Without site knowledge, AI-generated tests can't produce realistic navigation sequences or accurate selectors.

**Solution:** Raiken's autonomous DOM traversal:
- 🔍 Crawls your application to discover all reachable pages
- 🗺️ Maps navigation paths and working selectors
- 🛡️ Detects authentication requirements
- 🧠 Feeds discovered knowledge into test generation
- ⏸️ Pauses for human-in-the-loop authentication
- 💾 Persists everything to `.raiken/raiken.db`

## Quick Start

### 1. Discover Your Application

```bash
# Discover a local development server
raiken discover http://localhost:3000

# Discover with custom limits
raiken discover http://localhost:3000 --max-pages 50 --max-depth 3
```

### 2. Handle Authentication (if prompted)

If Raiken encounters a login page, it will pause and prompt you:

```
🛑 Authentication required at http://localhost:3000/login

Options:
  1. Run 'raiken auth' to log in
  2. Run 'raiken discover --skip-auth' to skip protected routes
  3. Press Ctrl+C to cancel
```

Authenticate manually:

```bash
# Open browser and log in
raiken auth --url http://localhost:3000/login

# Continue discovery with saved auth state
raiken discover --continue
```

### 3. Generate Tests with Site Knowledge

Once discovery is complete, Raiken automatically uses the site knowledge:

```bash
raiken start
# In the chat, ask: "Generate a test for the user profile page"
# Raiken will use verified selectors and navigation paths!
```

## Commands

### `raiken discover [url] [options]`

Autonomously discover web application structure.

**Arguments:**
- `url` - Starting URL to discover from (required for new discovery)

**Options:**
- `--max-pages <number>` - Maximum pages to discover (default: 100)
- `--max-depth <number>` - Maximum navigation depth (default: 5)
- `--auth` - Prompt for authentication before starting
- `--skip-auth` - Skip authentication-required routes
- `--continue` - Resume a paused discovery session
- `--status` - Show discovery statistics

**Examples:**

```bash
# Basic discovery
raiken discover http://localhost:3000

# Limited discovery (for large apps)
raiken discover http://localhost:3000 --max-pages 50 --max-depth 3

# Skip authentication (for public-only testing)
raiken discover http://localhost:3000 --skip-auth

# Resume after pausing
raiken discover --continue

# Check status
raiken discover --status
```

### `raiken auth [options]`

Manually authenticate to save browser session state.

**Options:**
- `--url <url>` - URL to navigate to for authentication

**Examples:**

```bash
# Open browser and wait for manual login
raiken auth

# Navigate to specific login page
raiken auth --url http://localhost:3000/login
```

**What happens:**
1. Browser opens in visible mode
2. You manually complete the login process
3. Press Enter when done
4. Raiken saves cookies and storage state to `.raiken/auth-state.json`
5. Future discoveries automatically use this auth state

## Configuration

Add discovery settings to `raiken.config.json`:

```json
{
  "discovery": {
    "maxPages": 100,
    "maxDepth": 5,
    "maxConcurrency": 3,
    "timeout": 30000,
    "excludePatterns": ["/logout", "/signout", "/api/"],
    "pauseOnAuth": true
  }
}
```

**Configuration Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxPages` | number | 100 | Maximum pages to discover |
| `maxDepth` | number | 5 | Maximum navigation depth from start URL |
| `maxConcurrency` | number | 3 | Concurrent browser instances |
| `timeout` | number | 30000 | Timeout per page (milliseconds) |
| `excludePatterns` | string[] | [] | URL patterns to exclude (e.g., `/logout`) |
| `pauseOnAuth` | boolean | true | Pause when authentication detected |

## How It Works

### 1. Crawling Phase

Raiken uses [Crawlee](https://crawlee.dev/) with Playwright to:
- Start at the provided URL
- Extract all links on the page
- Navigate to each link (breadth-first)
- Respect `maxPages` and `maxDepth` constraints
- Save page snapshots and selectors

### 2. Authentication Detection

On each page, Raiken checks for 5 authentication patterns:

1. **URL Patterns**: `/login`, `/signin`, `/auth`
2. **Login Forms**: Password field + submit button
3. **OAuth Buttons**: "Sign in with Google/GitHub"
4. **Error Messages**: "Access denied", "Unauthorized"
5. **HTTP Status**: 401, 403 responses

When detected, discovery pauses for human-in-the-loop authentication.

### 3. Knowledge Persistence

All discovered data is stored in `.raiken/raiken.db`:

- **Pages**: URL, title, depth, snapshot
- **Links**: From/to URLs, selectors, verification status
- **Auth Blockers**: Detected authentication requirements
- **Sessions**: Progress for pause/resume

### 4. Test Generation Integration

When generating tests, Raiken:
- Loads site knowledge from the database
- Includes verified navigation paths in prompts
- Recommends working selectors
- Warns about auth-required routes
- Avoids broken links

**Example prompt addition:**

```
## Site Discovery Knowledge
Raiken has autonomously discovered 47 pages in this application.

### Verified Navigation Paths
- http://localhost:3000 → http://localhost:3000/dashboard ("Dashboard")
  Selector: `a[href="/dashboard"]`
- http://localhost:3000/dashboard → http://localhost:3000/profile ("Profile")
  Selector: `a[href="/profile"]`

### Recommended Selectors
- `a[href="/dashboard"]` (role: link) - used 5x
- `button[type="submit"]` - used 12x
```

## Authentication Handling

### Flow: Pause → Authenticate → Resume

1. **Discovery encounters login page**
   ```
   🛑 Authentication required at /login
   Discovery paused. Run 'raiken auth' to continue.
   ```

2. **Manual authentication**
   ```bash
   raiken auth --url http://localhost:3000/login
   # Browser opens → you log in → press Enter
   # Auth state saved to .raiken/auth-state.json
   ```

3. **Resume discovery**
   ```bash
   raiken discover --continue
   # Loads auth state automatically
   # Continues crawling protected routes
   ```

### Saved Auth State

The `.raiken/auth-state.json` file contains:
- Session cookies
- Local storage data
- Session storage data

This file is loaded automatically in future discoveries and test runs.

**Security Note:** Add `.raiken/` to `.gitignore` (Raiken does this automatically). Never commit authentication credentials.

## Advanced Usage

### Large Applications

For large apps (100+ pages), use incremental discovery:

```bash
# Discover public pages first
raiken discover http://localhost:3000 --max-pages 50

# Authenticate
raiken auth

# Discover protected pages
raiken discover http://localhost:3000 --continue --max-pages 100
```

### Excluding Routes

Prevent discovery from visiting certain URLs:

```json
{
  "discovery": {
    "excludePatterns": [
      "/logout",
      "/signout",
      "/api/",
      "/admin/delete"
    ]
  }
}
```

### Programmatic Usage

```typescript
import { SiteDiscovery } from '@raiken/core';

const discovery = new SiteDiscovery({
  startUrl: 'http://localhost:3000',
  projectPath: process.cwd(),
  maxPages: 50,
  maxDepth: 3,
  pauseOnAuth: true,
});

// Listen for events
discovery.on('page_discovered', (event) => {
  console.log('Discovered:', event.data.page.url);
});

discovery.on('auth_blocked', (event) => {
  console.log('Auth required:', event.data.blocker.url);
  discovery.pause();
});

await discovery.start();
```

### Database Queries

Access discovered data directly:

```typescript
import { CodeGraphDB, SiteKnowledgeDB } from '@raiken/core';

const db = new CodeGraphDB(process.cwd());
const siteDb = new SiteKnowledgeDB(db.db, process.cwd());

// Get all discovered pages
const pages = siteDb.getAllPages();
console.log(`Discovered ${pages.length} pages`);

// Get verified navigation paths
const verifiedLinks = siteDb.getVerifiedLinks();

// Get auth blockers
const blockers = siteDb.getUnresolvedBlockers();

db.close();
```

## Troubleshooting

### Discovery hangs on a page

**Problem:** A page takes too long to load.

**Solution:** Reduce timeout or exclude the URL:

```bash
raiken discover http://localhost:3000 --timeout 15000
```

Or in config:
```json
{
  "discovery": {
    "timeout": 15000,
    "excludePatterns": ["/slow-page"]
  }
}
```

### Authentication not detected

**Problem:** Raiken doesn't detect login pages.

**Solution:** Manually authenticate first:

```bash
raiken auth --url http://localhost:3000/login
raiken discover http://localhost:3000
```

### Discovery discovers too many pages

**Problem:** Raiken crawls external links or unwanted sections.

**Solution:** Use `maxPages`, `maxDepth`, and `excludePatterns`:

```bash
raiken discover http://localhost:3000 --max-pages 50 --max-depth 3
```

```json
{
  "discovery": {
    "excludePatterns": ["/blog", "/docs", "/api"]
  }
}
```

### Cannot resume session

**Problem:** `raiken discover --continue` says no session found.

**Solution:** Check if the previous session completed or failed:

```bash
raiken discover --status
```

If status shows "completed" or "failed", start a new discovery:

```bash
raiken discover http://localhost:3000
```

### Tests still fail after discovery

**Problem:** Generated tests don't use discovered selectors.

**Solution:**

1. Verify site knowledge was loaded:
   ```bash
   raiken discover --status
   # Should show pages discovered
   ```

2. Check if discovery completed:
   ```bash
   raiken discover --status
   # Status should be "completed", not "paused"
   ```

3. Regenerate tests after discovery:
   ```bash
   raiken start
   # Generate new tests - they'll use site knowledge
   ```

## What Gets Discovered

### Pages
- URL (normalized)
- Title
- Depth from start URL
- Accessibility snapshot
- Parent page
- Visit count

### Links
- From URL → To URL
- Selector used
- Link text
- Element role
- Verification status (working/broken)

### Auth Blockers
- URL where auth was detected
- Detection type (URL pattern, form, OAuth, etc.)
- Detected elements (e.g., password field selector)
- Resolution status

### Sessions
- Start URL
- Status (running, paused, completed)
- Pages discovered / links found
- Start/completion timestamps
- Blocked URL (if paused for auth)

## Best Practices

1. **Discover before generating tests**: Run discovery once, generate tests many times
2. **Use --status frequently**: Check progress without disrupting discovery
3. **Authenticate early**: Run `raiken auth` before discovery for better coverage
4. **Exclude destructive routes**: Add `/logout`, `/delete`, `/admin` to `excludePatterns`
5. **Start small**: Use `--max-pages 20` to test on a subset first
6. **Version your config**: Commit `raiken.config.json`, not `.raiken/`

## API Reference

See [libs/core/src/site-discovery](../libs/core/src/site-discovery) for full API documentation.

## FAQ

**Q: Does discovery modify my application?**
A: No. Discovery is read-only. It only navigates and reads page content.

**Q: How long does discovery take?**
A: Depends on `maxPages` and `timeout`. Typically 1-5 minutes for 50-100 pages.

**Q: Can I run discovery in CI/CD?**
A: Yes, but skip auth detection: `raiken discover <url> --skip-auth`

**Q: Does discovery work with SPAs?**
A: Yes. Raiken waits for `domcontentloaded` and extracts client-side rendered content.

**Q: Can I customize auth detection?**
A: Currently no, but you can manually authenticate with `raiken auth` to bypass detection.

## Related Documentation

- [Configuration Guide](./CONFIGURATION.md) - Full config options
- [CLI Commands](./CLI.md) - All available commands
- [Architecture](./ARCHITECTURE.md) - How Raiken works internally

---

**Need help?** Open an issue at [github.com/raiken-foundation/raiken-app/issues](https://github.com/raiken-foundation/raiken-app/issues)
