# Complete Testing Guide: Autonomous DOM Traversal

This guide walks you through testing the site discovery feature using the **playground test app** included in this project.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Understanding the Playground App](#understanding-the-playground-app)
3. [Test Setup](#test-setup)
4. [Test Scenarios](#test-scenarios)
5. [Expected Results](#expected-results)
6. [Verification Checklist](#verification-checklist)
7. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### 1. Build the Project

```bash
# Install dependencies
pnpm install

# Build the CLI
nx build cli

# Link the CLI globally (optional but recommended)
cd dist/apps/cli
npm link
cd ../../..
```

### 2. Verify Installation

```bash
raiken --version
# Should show: 0.2.0 (or similar)

raiken --help
# Should show discover and auth commands
```

---

## Understanding the Playground App

The playground app (`tools/playground`) is a React application with:

### **Pages/Views:**
1. **Login Page** (unauthenticated)
   - Form with username + email fields
   - Client-side validation
   - No actual backend authentication

2. **Dashboard** (authenticated)
   - Counter component with increment/decrement
   - Todo list with add/complete/delete
   - Logout button

### **Perfect for Testing Because:**
- ✅ Has authentication (form-based)
- ✅ Multiple interactive elements
- ✅ State changes (counter, todos)
- ✅ Navigation between views (login → dashboard)
- ✅ Already has data-testid attributes

---

## Test Setup

### Step 1: Start the Playground App

```bash
cd tools/playground
pnpm install  # If not already installed
pnpm dev
```

**Expected output:**
```
VITE v5.x.x  ready in XXX ms

➜  Local:   http://localhost:5173/
➜  Network: use --host to expose
```

**Verify:** Open http://localhost:5173 in your browser. You should see the login page.

### Step 2: Initialize Raiken in Playground

```bash
# From project root
cd tools/playground
raiken init
```

**Expected output:**
```
✅ Created .raiken/ directory
✅ Updated .gitignore
✅ Raiken initialized successfully
```

### Step 3: Build the Code Graph (Optional but Recommended)

```bash
cd tools/playground
raiken start &
# Wait for server to start, then stop it (Ctrl+C)
# This creates the initial database
```

---

## Test Scenarios

### 🧪 **Test 1: Basic Discovery (No Auth)**

**Purpose:** Test if discovery can crawl a single page without authentication.

**Steps:**

1. Ensure playground is running at http://localhost:5173
2. Run discovery with minimal settings:

```bash
cd tools/playground
raiken discover http://localhost:5173 --max-pages 5 --max-depth 1
```

**Expected Behavior:**

```
🔍 Starting site discovery...

  URL:       http://localhost:5173
  Max pages: 5
  Max depth: 1
  Auth mode: pause

⠋ Pages: 1/5 | Links: 3 | Depth: 0/1 | Elapsed: 2s
  http://localhost:5173

🛑 Authentication required at http://localhost:5173

Detected: login_form (password field + submit button)

Options:
  1. Run 'raiken auth' to log in
  2. Run 'raiken discover --skip-auth' to skip protected routes
  3. Press Ctrl+C to cancel

Discovery paused. Session can be resumed with 'raiken discover --continue'.
```

**Why this happens:**
- Discovery detects the login form (username + email inputs)
- Pauses automatically (default behavior)
- Waits for human authentication

**✅ Pass Criteria:**
- Discovery starts successfully
- Detects authentication on the login page
- Pauses with clear instructions
- Session is saved (can be resumed)

---

### 🧪 **Test 2: Discovery with Skip Auth**

**Purpose:** Test discovery without authentication handling.

**Steps:**

```bash
cd tools/playground
raiken discover http://localhost:5173 --max-pages 10 --skip-auth
```

**Expected Behavior:**

```
🔍 Starting site discovery...

  URL:       http://localhost:5173
  Max pages: 10
  Max depth: 5
  Auth mode: skip

⠋ Pages: 1/10 | Links: 0 | Depth: 0/5 | Elapsed: 3s
  http://localhost:5173

✓ Discovery completed!

📊 Summary:
   Pages discovered: 1
   Links found:      0
   Auth blockers:    1
   Time elapsed:     3s

✨ Site knowledge saved to .raiken/raiken.db
```

**Why this happens:**
- Discovery skips authentication
- Finds only the login page (no links without auth)
- Completes successfully but with limited coverage

**✅ Pass Criteria:**
- Discovery completes without pausing
- Discovers at least 1 page (the login page)
- Auth blocker is detected but not acted upon
- Session status shows "completed"

---

### 🧪 **Test 3: Manual Authentication Flow**

**Purpose:** Test the complete HITL (Human-in-the-Loop) authentication workflow.

**Steps:**

1. **Start Discovery (will pause on auth):**

```bash
cd tools/playground
raiken discover http://localhost:5173 --max-pages 20
```

Wait for it to pause on authentication detection.

2. **Manually Authenticate:**

```bash
# In a new terminal
cd tools/playground
raiken auth --url http://localhost:5173
```

**In the browser that opens:**
- Enter username: `testuser` (3-20 characters)
- Leave email empty or enter valid email
- Click "Login"
- **Press Enter in the terminal when done**

**Expected output:**
```
🔐 Starting authentication flow...

✓ Browser launched

📝 Please log in to your application.
   The browser will remain open for you to:
   1. Navigate to the login page (if not already there)
   2. Complete the login process
   3. Verify you're logged in

Press Enter when you've completed the login...

⠋ Saving authentication state...
✓ Authentication state saved!

   Saved to: /path/to/.raiken/auth-state.json

📊 Summary:
   Cookies saved:        0
   Storage origins:      1

✅ Authentication complete! You can now run 'raiken discover' to crawl protected routes.
```

3. **Resume Discovery:**

```bash
raiken discover --continue
```

**Expected Behavior:**

```
▶️  Resuming discovery...

⠋ Pages: 2/20 | Links: 5 | Depth: 1/5 | Elapsed: 5s
  http://localhost:5173/dashboard

✓ Discovery completed!

📊 Summary:
   Pages discovered: 1
   Links found:      5
   Time elapsed:     5s
```

**Note:** Since the playground is a SPA (Single Page Application), it may still show 1 page but with multiple interactive elements discovered.

**✅ Pass Criteria:**
- `raiken auth` successfully captures login state
- Auth state saved to `.raiken/auth-state.json`
- `raiken discover --continue` resumes successfully
- Discovery completes with authenticated state
- Can access protected components (Counter, TodoList)

---

### 🧪 **Test 4: Discovery Status Checking**

**Purpose:** Test status reporting and session management.

**Steps:**

```bash
cd tools/playground
raiken discover --status
```

**Expected Output:**

```
📊 Discovery Status

Last Session:
  Status:   completed
  Started:  2/11/2026, 10:30:15 AM
  Completed: 2/11/2026, 10:30:32 AM

Statistics:
  Pages discovered:     1
  Links found:          5
  Verified links:       0
  Broken links:         0
  Auth blockers:        1
  Unresolved blockers:  0
```

**✅ Pass Criteria:**
- Shows latest session information
- Displays accurate statistics
- Status reflects actual state (running/paused/completed)

---

### 🧪 **Test 5: Site Knowledge Integration with Test Generation**

**Purpose:** Verify that discovered site knowledge is used in test generation.

**Steps:**

1. **Ensure discovery is complete:**

```bash
cd tools/playground
raiken discover --status
# Should show "completed" status with pages discovered
```

2. **Start Raiken and generate a test:**

```bash
cd tools/playground
raiken start
```

Wait for the dashboard to open at http://localhost:4200.

3. **In the chat interface, ask:**

```
Generate a test that logs in and increments the counter
```

4. **Examine the generated test code:**

**What to look for:**
- ✅ Test includes login steps (uses discovered form selectors)
- ✅ Uses `data-testid` attributes that were discovered
- ✅ Navigation steps match discovered paths
- ✅ Selectors are accurate (e.g., `[data-testid="username-input"]`)

**Example expected test structure:**

```typescript
import { test, expect } from '@playwright/test';

test('should login and increment counter', async ({ page }) => {
  // Login using discovered selectors
  await page.goto('http://localhost:5173');
  await page.getByTestId('username-input').fill('testuser');
  await page.getByTestId('login-submit').click();

  // Wait for authenticated view
  await expect(page.getByText('Welcome, testuser!')).toBeVisible();

  // Increment counter using discovered selectors
  await page.getByTestId('increment-btn').click();
  await expect(page.getByTestId('counter-value')).toHaveText('1');
});
```

**✅ Pass Criteria:**
- Test generation includes site knowledge context
- Generated selectors match discovered elements
- Login flow is included automatically
- Test is more accurate than without discovery

---

### 🧪 **Test 6: Database Verification**

**Purpose:** Verify data persistence in the database.

**Steps:**

1. **Inspect the database directly:**

```bash
cd tools/playground/.raiken
sqlite3 raiken.db
```

2. **Run SQL queries:**

```sql
-- Check schema version
PRAGMA user_version;
-- Should return: 4

-- Check discovered pages
SELECT COUNT(*) FROM discovered_pages;
SELECT url, title, depth FROM discovered_pages;

-- Check discovered links
SELECT COUNT(*) FROM discovered_links;
SELECT from_url, to_url, selector, status FROM discovered_links LIMIT 5;

-- Check auth blockers
SELECT COUNT(*) FROM auth_blockers;
SELECT url, blocker_type, resolved_at FROM auth_blockers;

-- Check sessions
SELECT id, start_url, status, pages_discovered, links_found FROM discovery_sessions;

.exit
```

**Expected Results:**

```sql
PRAGMA user_version;
-- 4

SELECT COUNT(*) FROM discovered_pages;
-- 1 or more

SELECT url, title FROM discovered_pages;
-- http://localhost:5173|Raiken Playground

SELECT COUNT(*) FROM auth_blockers;
-- 1

SELECT blocker_type FROM auth_blockers;
-- login_form (or similar)
```

**✅ Pass Criteria:**
- Schema version is 4
- Tables exist: discovered_pages, discovered_links, auth_blockers, discovery_sessions
- Data is present in tables
- Foreign key relationships are intact

---

### 🧪 **Test 7: Configuration Override**

**Purpose:** Test custom discovery configuration.

**Steps:**

1. **Create `raiken.config.json` in playground:**

```bash
cd tools/playground
cat > raiken.config.json << 'EOF'
{
  "testDirectory": "e2e",
  "discovery": {
    "maxPages": 10,
    "maxDepth": 2,
    "maxConcurrency": 2,
    "timeout": 15000,
    "excludePatterns": ["/logout"],
    "pauseOnAuth": false
  }
}
EOF
```

2. **Run discovery:**

```bash
raiken discover http://localhost:5173
```

**Expected Behavior:**
- Discovery uses custom settings (10 pages max, depth 2)
- Does NOT pause on auth (pauseOnAuth: false)
- Respects timeout of 15 seconds per page

**✅ Pass Criteria:**
- Configuration is loaded from raiken.config.json
- Discovery respects custom limits
- Auth detection behavior matches config

---

### 🧪 **Test 8: tRPC Endpoints (Dashboard Integration)**

**Purpose:** Test the tRPC endpoints for site discovery.

**Steps:**

1. **Start the Raiken server:**

```bash
cd tools/playground
raiken start
```

2. **Open the dashboard:** http://localhost:4200

3. **Open browser DevTools** → Console

4. **Test the endpoints:**

```javascript
// Assuming you have access to the tRPC client
// This would typically be in the dashboard code

// Get discovery stats
fetch('http://localhost:7101/api/getDiscoveryStats', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({})
}).then(r => r.json()).then(console.log);

// Get discovery session
fetch('http://localhost:7101/api/getDiscoverySession', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({})
}).then(r => r.json()).then(console.log);
```

**Expected Response (getDiscoveryStats):**

```json
{
  "result": {
    "data": {
      "pagesCount": 1,
      "linksCount": 5,
      "verifiedLinksCount": 0,
      "brokenLinksCount": 0,
      "authBlockersCount": 1,
      "unresolvedBlockersCount": 0,
      "timestamp": "2026-02-11T18:30:45.123Z"
    }
  }
}
```

**✅ Pass Criteria:**
- Endpoints return valid JSON
- Statistics match database state
- No errors in console

---

## Expected Results

### Overall Success Criteria

After running all tests, you should observe:

#### ✅ **CLI Commands**
- [x] `raiken discover` starts and runs successfully
- [x] `raiken auth` captures authentication state
- [x] `raiken discover --continue` resumes paused sessions
- [x] `raiken discover --status` shows accurate statistics
- [x] Progress spinner shows real-time updates
- [x] Error messages are clear and actionable

#### ✅ **Discovery Behavior**
- [x] Detects authentication requirements
- [x] Pauses on auth detection (when pauseOnAuth: true)
- [x] Respects maxPages and maxDepth limits
- [x] Excludes patterns from excludePatterns
- [x] Saves session state for resume
- [x] Completes successfully

#### ✅ **Database Persistence**
- [x] Schema migrated to v4
- [x] All 4 new tables created
- [x] Data persisted correctly
- [x] Foreign keys maintained
- [x] Indexes created for performance

#### ✅ **Agent Integration**
- [x] Site knowledge loaded in test generation
- [x] Prompts include discovered selectors
- [x] Navigation paths are suggested
- [x] Auth requirements noted
- [x] Tests are more accurate

#### ✅ **Configuration**
- [x] Loads from raiken.config.json
- [x] Merges with defaults correctly
- [x] CLI flags override config
- [x] Validation errors are clear

---

## Verification Checklist

Print this checklist and check off each item as you test:

### Setup
- [ ] Project built successfully (`nx build cli`)
- [ ] CLI accessible (`raiken --version` works)
- [ ] Playground app running at http://localhost:5173
- [ ] Can see login page in browser

### Basic Discovery
- [ ] `raiken discover http://localhost:5173` starts
- [ ] Progress spinner shows updates
- [ ] Detects authentication requirement
- [ ] Pauses with clear message
- [ ] Session saved for resume

### Authentication Flow
- [ ] `raiken auth` opens browser
- [ ] Can complete login manually
- [ ] Auth state saved to `.raiken/auth-state.json`
- [ ] File contains cookies and storage data
- [ ] `raiken discover --continue` loads auth state

### Discovery Completion
- [ ] Discovery completes successfully
- [ ] Summary shows statistics
- [ ] `raiken discover --status` displays results
- [ ] Database populated with data

### Database Verification
- [ ] `.raiken/raiken.db` exists
- [ ] Schema version is 4
- [ ] All 4 tables present
- [ ] Data visible in tables
- [ ] No SQL errors

### Test Generation
- [ ] `raiken start` launches dashboard
- [ ] Can generate tests in chat
- [ ] Site knowledge mentioned in logs
- [ ] Generated tests use discovered selectors
- [ ] Tests more accurate than without discovery

### Configuration
- [ ] `raiken.config.json` respected
- [ ] Custom limits enforced
- [ ] Custom patterns excluded
- [ ] Validation errors shown for invalid config

### Error Handling
- [ ] Invalid URL shows error
- [ ] Network failures handled gracefully
- [ ] Browser crashes don't corrupt database
- [ ] Session resume works after interruption

---

## Troubleshooting

### Issue: Discovery immediately completes with 0 pages

**Diagnosis:**
```bash
raiken discover --status
# Check if previous session completed
```

**Solution:**
```bash
# Clear discovery data and try again
raiken start  # Open dashboard
# Manually call clearDiscoveryData via tRPC
# OR delete .raiken/raiken.db and restart
```

---

### Issue: Auth detection doesn't work

**Diagnosis:**
- Check if page has password input or login patterns
- Verify URL matches `/login` or similar

**Solution:**
```bash
# Manually authenticate first
raiken auth --url http://localhost:5173
raiken discover http://localhost:5173
```

---

### Issue: Discovery hangs

**Diagnosis:**
- Page loading timeout exceeded
- JavaScript errors on page

**Solution:**
```bash
# Reduce timeout
raiken discover http://localhost:5173 --timeout 10000

# Or skip problematic pages
# Add to raiken.config.json:
{
  "discovery": {
    "excludePatterns": ["/slow-page"]
  }
}
```

---

### Issue: Generated tests don't use site knowledge

**Diagnosis:**
```bash
raiken discover --status
# Check: pages_discovered > 0
```

**Solution:**
1. Ensure discovery completed successfully
2. Check `.raiken/raiken.db` has data
3. Restart Raiken server: `raiken start`
4. Look for "Site knowledge loaded" message in logs

---

### Issue: Database migration failed

**Symptoms:**
- Errors mentioning "no such table"
- Schema version not 4

**Solution:**
```bash
cd tools/playground
# Backup existing database
cp .raiken/raiken.db .raiken/raiken.db.backup

# Delete and recreate
rm -rf .raiken/
raiken init

# Re-run discovery
raiken discover http://localhost:5173
```

---

### Issue: Browser doesn't open for `raiken auth`

**Diagnosis:**
- Playwright not installed
- Permissions issue

**Solution:**
```bash
# Install Playwright browsers
cd tools/playground
npx playwright install chromium

# Try again
raiken auth
```

---

## Performance Benchmarks

Expected performance for the playground app:

| Metric | Expected Value | Acceptable Range |
|--------|---------------|------------------|
| Discovery time (1 page) | 2-5 seconds | 1-10 seconds |
| Auth detection time | < 1 second | < 3 seconds |
| Database write time | < 100ms | < 500ms |
| Session resume time | < 2 seconds | < 5 seconds |
| Test generation with knowledge | 5-10 seconds | 3-15 seconds |

---

## Advanced Testing Scenarios

### Scenario A: Multi-Page SPA Simulation

Since the playground is a SPA, modify App.tsx to use React Router for true multi-page navigation:

```bash
# This would require code changes
# Out of scope for basic testing
```

### Scenario B: Stress Test

```bash
# Discover with high limits
raiken discover http://localhost:5173 --max-pages 1000 --max-depth 10

# Should handle gracefully:
# - Stop at actual page limit (1 page for playground)
# - No memory leaks
# - Database integrity maintained
```

### Scenario C: Concurrent Discovery

```bash
# Terminal 1
raiken discover http://localhost:5173 --max-pages 10

# Terminal 2 (while first is running)
raiken discover --status

# Should show:
# - First session as "running"
# - Stats update in real-time
```

---

## Success Metrics

At the end of testing, you should have:

1. **✅ 8 test scenarios passed**
2. **✅ All verification checklist items checked**
3. **✅ Database populated with discovery data**
4. **✅ Auth state saved and reusable**
5. **✅ Generated tests use site knowledge**
6. **✅ No critical errors or crashes**

---

## Reporting Issues

If you encounter bugs, please report with:

1. **Test scenario** that failed
2. **Expected vs actual** behavior
3. **Error messages** (full stack trace)
4. **Environment info**:
   ```bash
   raiken --version
   node --version
   pnpm --version
   sqlite3 --version
   ```
5. **Database state**:
   ```bash
   cd tools/playground/.raiken
   sqlite3 raiken.db "SELECT * FROM discovery_sessions;"
   ```
6. **Logs** from console output

---

## Next Steps After Testing

1. **If all tests pass:**
   - Feature is ready for production use
   - Start using on real projects
   - Gather feedback on UX improvements

2. **If some tests fail:**
   - Document failures
   - Prioritize fixes by severity
   - Re-test after fixes

3. **Performance issues:**
   - Profile slow operations
   - Optimize database queries
   - Add caching where appropriate

---

## Quick Test Script

For rapid testing, use this script:

```bash
#!/bin/bash
# quick-test.sh

cd tools/playground

echo "1️⃣  Starting playground..."
pnpm dev &
PLAYGROUND_PID=$!
sleep 5

echo "2️⃣  Running basic discovery..."
raiken discover http://localhost:5173 --max-pages 5 --skip-auth

echo "3️⃣  Checking status..."
raiken discover --status

echo "4️⃣  Verifying database..."
sqlite3 .raiken/raiken.db "SELECT COUNT(*) FROM discovered_pages;"

echo "5️⃣  Cleaning up..."
kill $PLAYGROUND_PID

echo "✅ Quick test complete!"
```

Save as `quick-test.sh`, make executable (`chmod +x quick-test.sh`), and run.

---

**Happy Testing! 🚀**

For questions or issues, refer to [SITE_DISCOVERY.md](./SITE_DISCOVERY.md) or open a GitHub issue.
