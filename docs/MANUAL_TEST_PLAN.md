# Raiken Manual Test Plan

Use `tools/playground` as your test target unless otherwise noted. Open two terminals: one for `raiken` commands, one for `pnpm exec playwright …` if needed.

---

## 0. Setup (do this once)

```bash
cd /Users/Armand/Documents/Code/raiken-app
pnpm nx run cli:build:dev          # builds CLI + dashboard + installs deps
export PATH="$PWD/dist/apps/cli:$PATH"   # or alias raiken to dist/apps/cli/bin.cjs
cd tools/playground                 # any project will work; playground is wired
echo "OPENROUTER_API_KEY=sk-..." > .env   # required for AI features
raiken init                         # creates raiken.config.json + .raiken/
```

**Expected:** A `raiken.config.json` is created, `.raiken/raiken.db` appears on first run.

**Edge cases to verify:**

- `raiken init` (no `--force`) on an existing config → it warns and exits without overwriting.
- `raiken init --force` → overwrites cleanly.
- Missing `OPENROUTER_API_KEY` → `raiken start` warns but still boots; AI calls fail gracefully in the dashboard (a banner appears in the chat).

---

## 1. Dashboard — `raiken start`

```bash
raiken start                # default port 7101
raiken start --port 8088    # custom port
```

Open `http://localhost:7101`. Hard refresh (`Cmd+Shift+R`) to pick up the new purple theme.

### 1.1 Chrome (visible on every view)

- **Nav rail** (left, 44px): four icons — Testing, Discovery, Quality, Settings. Active item shows a purple bar on the right edge.
- **Header**: shows `raiken › <project>` with status dots.
- **Connection error overlay**: stop the CLI (`Ctrl+C`) → after ~30s the dashboard shows an `OFFLINE raiken/server` card with a `$ raiken start` hint and a `retry` button. Restart and click retry.

### 1.2 Routing / deep links

- Click each nav item → URL hash updates to `#/testing`, `#/discovery`, `#/quality`, `#/settings`.
- Manually visit `#/quality/doctor` → lands on Quality with the Doctor sub-tab active (this was the bug we fixed).
- Click each Quality sub-tab → it changes the panel **without** redirecting to Testing.

---

## 2. Testing View (`#/testing`)

This is the main workspace: sidebar (Chat/Files) + code editor + test results panel.

### 2.1 Chat tab — generate a test

1. Type into the prompt: `Generate an E2E test that opens the homepage and clicks the Login button`.
2. Press Enter.
3. **Expected:** loading shows lowercase `generating…`, then a code block streams in. A new `.spec.ts` file appears in the editor and Files panel.

**Edge cases:**

- Send an empty message → input is rejected silently.
- Send a non-test request (e.g. "what's the weather?") → AI replies but no file is saved.
- Click a code block in the chat with the `Open in editor` action → file opens as a scratch tab.
- Confirm HITL (Human-In-The-Loop) prompts: ask for something destructive ("delete the e2e folder"); the agent should ask for confirmation before acting.

### 2.2 Files tab — browse tests

- Switch to **Files** tab in the sidebar.
- Filter with `/` then type `login`.
- Expected: tree collapses/expands with `▾`, files show status dots (pass/fail/pending), full path appears as a tooltip.
- Click a file → it opens in the editor and the Files panel highlights it.

### 2.3 Code editor (Monaco)

- Open a `.spec.ts` file. Verify:
  - Single tab bar (no double-row of file name + buttons — that was the previous bug).
  - Icon-only toolbar buttons: Save, New, Delete, Run.
  - Monaco cursor is **purple**.
  - Ctrl/Cmd+S → triggers Save; "Saved" indicator flashes briefly.
  - Run button (▶) → kicks off Playwright; status pill changes to `running`.
- Make an edit → tab gets a "dirty" dot.
- Delete a file → confirm dialog → file disappears from disk and editor.

### 2.4 Test results panel (bottom)

1. Run a test that passes.
2. Verify:
   - Header shows `● raiken/results · passed N · failed 0 · time Ns`.
   - Toggle **Formatted ↔ Raw ↔ Artifacts ↔ Insights** sub-tabs.
   - Click a test row → details expand below (error stack, snippet, attachments).
   - Failing tests have a red left border; their error messages are wrapped with a `fail` semantic color.
3. Click **Analyze with AI** → loading spinner → markdown interpretation appears in the **Insights** panel.

**Edge cases:**

- Run a syntax-error test → top-level errors appear under "Build Errors".
- Run with no test selected → button is disabled.
- Tests with screenshots/videos → they appear in the **Artifacts** sub-tab as cards (images render, others as list rows).

### 2.5 Resize handle

- Drag the vertical bar between sidebar and editor → it snaps between 280–600px and the handle highlights purple while dragging.

---

## 3. Discovery View (`#/discovery`)

### 3.1 Run a basic crawl

1. Enter Start URL: `http://localhost:3000` (or any local site you have running; the playground has a small Vite app).
2. Leave defaults (max 100 pages, depth 5).
3. Click **Start Discovery**.
4. **Expected:**
   - Phase pill shows `● running` (purple/green).
   - Progress bar fills with the percentage label.
   - Stat grid updates live (Pages / Links / Verified / Broken / Blockers).
   - The **Activity** card streams a timeline of `[type]` events.

### 3.2 Blockers (auth, captcha, manual pause, error pages)

The dashboard now renders every paused-on reason — not just auth — through a generic `BlockerPanel` with per-row resolution actions.

#### 3.2.a Auth blocker (login wall)

1. Run discovery against a site with a login wall.
2. **Expected:** phase becomes `◐ paused`, the BlockerPanel appears with an amber **Authentication required** badge for each unresolved row.
3. Each row exposes four buttons: `I've handled it — continue`, `Skip URL`, `Ignore this kind`, `Open login in browser`.
4. **Path A — terminal:** copy the `raiken auth --url …` command shown under the panel header, run it in another terminal, then click `I've handled it — continue` (or just click the top-of-page **Continue** button — auto-resume kicks in once every blocker has a recorded resolution).
5. **Path B — dashboard handoff:** click `Open login in browser` on the row → a real Chromium window pops at the blocked URL → log in → close the window. The panel auto-clears, the crawl resumes.

#### 3.2.b Captcha blocker (playground)

1. Inject a Cloudflare Turnstile / reCAPTCHA iframe into a playground page (or visit a real route that has one).
2. **Expected:** the BlockerPanel shows a row with a **Captcha challenge** badge and an `Open in browser` button.
3. Click `Skip URL` → the row vanishes, the URL gets added to the session-scoped skip list (re-runs of the crawl ignore it), and discovery resumes from the start URL.
4. Or click `Open in browser` → solve the challenge in the headful window → close it → the crawl resumes with the captured cookies.

#### 3.2.c Manual pause (the "I'm driving now" affordance)

1. While the crawl is `● running`, click **Pause** in the action bar.
2. **Expected:** phase flips to `◐ paused` and a row appears in the BlockerPanel with a **Paused by you** badge. The only resolution buttons are `I've handled it — continue` and `Open in browser` (Skip / Ignore are hidden — they don't make sense for a user-initiated pause).
3. Auto-resume MUST NOT fire: confirm the crawl stays paused even after the runtime polls a few times. Clicking **Continue** resumes from the URL that was current when you paused.

#### 3.2.d Error page (5xx)

1. Stop the playground server (or point discovery at a URL that returns 502).
2. **Expected:** the BlockerPanel shows a row with a red **Error page** badge and an evidence pane that includes the HTTP status.
3. `Skip URL` → next URL is processed; `Ignore this kind` → 5xx pages are recorded but no longer pause the session.

#### 3.2.e CLI parity

`raiken auth` still works exactly as before; under the hood it shares the `manual-handoff.ts` helper with the dashboard's `Open in browser` button.

### 3.3 Results sub-tabs

- Click the **Results** top-tab (badge shows total count).
- **Pages** sub-tab: paginated table (20/page); each row has `Snapshot`, `Open`, `Generate Test` actions.
  - Click `Snapshot` → drawer slides in showing the captured DOM JSON.
  - Click `Generate Test` → toast says "Sending to AI Agent: <url>", then routes to `#/testing` with the URL prefilled in chat.
- **Verified** sub-tab: list of verified `from → to` links with selectors.
- **Broken** sub-tab: list of broken links with strikethrough URLs and error messages.

### 3.4 Edit exclude patterns

- Type `/admin` in the tag input → press Enter → tag appears.
- Click the `×` on a tag → it removes.

### 3.5 Clear data

- Click **Clear Data** → table empties, stats reset to 0.

**CLI parity check:**

```bash
raiken discover http://localhost:3000 --max-pages 20 --skip-auth
raiken discover --status
raiken discover --continue
```

---

## 4. Quality View (`#/quality`)

Five sub-tabs across the top. Each runs the corresponding CLI command via tRPC and renders the output in the same flat dev-tool style.

### 4.1 Doctor — `#/quality/doctor`

- Click **Run** → scans test files for anti-patterns (`waitForTimeout`, `.only`, hardcoded waits, etc.).
- **Expected:** results grouped by severity (`error`, `warning`, `info`) with file:line and rule name.
- Toggle the severity filter chips → list filters live.
- Edge case: run on a project with **no** issues → "all clean ✓" empty state.

CLI parity:

```bash
raiken doctor                      # default
raiken doctor --json               # machine output
raiken doctor --fail-on warning    # exit code 2 if any warnings
```

### 4.2 Impact — `#/quality/impact`

1. Make an edit in a source file (e.g. `src/components/Button.tsx`).
2. Click **Analyze**.
3. **Expected:** a list of test files likely affected, with confidence pills (high/med/low).
4. Click an impacted test row → evidence drawer opens (covers, runtime, imports, calls, renders, name_match).

CLI parity:

```bash
raiken ci --skip-run --json
raiken ci --base origin/main --max-tests 10
raiken ci --staged                # for pre-commit
```

### 4.3 Trace — `#/quality/trace`

1. Paste a stack trace into the textarea (any TypeError from a real run).
2. Click **Find tests**.
3. **Expected:** ranked list of tests most likely to reproduce that error.

CLI parity:

```bash
raiken trace "TypeError: Cannot read properties of undefined (reading 'name') at Button.tsx:42"
raiken trace -f /tmp/trace.txt --limit 5
```

### 4.4 Cover — `#/quality/cover`

1. Type a target: `AC-2`, `Button`, or free text like `"user should be able to checkout with Apple Pay"`.
2. Click **Draft test**.
3. **Expected:** a Playwright test scaffold appears; click "Save as…" to write it to `e2e/`.

CLI parity:

```bash
raiken cover "user can log in with Google" --ticket PROJ-123
raiken cover Button --dry-run     # writes a TODO scaffold without an LLM call
```

### 4.5 Context — `#/quality/context`

- Click **Generate snapshot** → builds `raiken.ctx.md` (the file that's open in your IDE right now).
- **Expected:** preview appears in a markdown viewer; "Open in editor" opens the rendered file.

CLI parity:

```bash
raiken context                                    # writes raiken.ctx.md
raiken context --output /tmp/ctx.md --max-rows 50
raiken context --no-impact --json
```

---

## 5. Settings View (`#/settings`)

Six sections in the left rail (purple bar shows the active one).

| Section | Verify |
|---|---|
| **General** | Edit `testDirectory`, save → confirm `raiken.config.json` updates. |
| **AI Provider** | Switch provider; paste an API key; reload page → key persists. |
| **Browser** | Toggle headless; change retries; save; run a test → setting takes effect. |
| **Discovery** | Tweak max pages/depth; add an exclude pattern; save → start discovery, confirm new defaults. |
| **Features** | Toggle video/screenshots/tracing/network → run a test → verify artifacts appear/disappear. |
| **Autonomy** | Set Auto-correct = `apply`; force a test failure → Raiken patches the test automatically. |

**Edge cases:**

- Click **Save** with no changes → button is disabled.
- Click **Discard** → form resets to last-saved state, dirty indicator clears.
- Submit invalid JSON via the API key field with weird chars → save error banner appears with the validation message.

---

## 6. Ticket Sync Bar (top of Testing view)

Visible on `#/testing` only.

1. Check out a feature branch named `feat/PROJ-123-add-checkout`.
2. The bar should detect `PROJ-123` and show `#PROJ-123 detected on feat/PROJ-123-add-checkout`.
3. Click **Sync** → fetches the ticket from your provider and shows title.
4. Click the impact badge → Impact Panel expands with affected tests, hot symbols, source files, and AI suggestions.
5. Click **Generate** on a suggestion → routes to chat with the suggested prompt prefilled.

CLI parity:

```bash
raiken sync                       # auto-detect from branch
raiken sync --ticket PROJ-123
```

**Edge cases:**

- Branch with no ticket → bar shows `<branch> · No ticket detected`.
- Run outside a git repo → `Not in a git repository`.
- Sync against an unconfigured provider → red `Sync failed: …` banner under the bar.

---

## 7. Git Hooks

```bash
raiken hooks status               # baseline
raiken hooks install --type pre-commit
git commit -m "test"              # hook runs raiken ci --staged
raiken hooks install --type pre-push --skip-run
raiken hooks uninstall --type pre-commit
```

**Verify:**

- `status` shows which hooks are present and whether they're raiken-managed.
- Installing twice is idempotent (no duplicate blocks in the hook file).
- Uninstall removes only the raiken-managed block, leaving any user code intact.
- With Husky present, hooks land in `.husky/`; without it, in `.git/hooks/`.

---

## 8. Cross-cutting things to spot-check

- **Dark theme**: every surface is `#0a0a0a`-ish, all hairlines are `#1c1c1c`, single purple accent (`#a78bfa`) is the only color besides semantic pass/warn/fail. No leftover blues, greens-on-buttons, or rounded "card" feel.
- **Monospace everywhere**: all text outside the chat message bodies uses JetBrains Mono.
- **Keyboard a11y**: tab through the nav rail, the sub-tabs, and the form inputs — focus rings should be visible (purple). All interactive elements have `aria-label` or visible text.
- **Reduced motion**: spinners are subtle, no large animations.
- **Bundle size sanity**: `dist/apps/dashboard/assets/index-*.css` should be ~30 kB (≈6.5 kB gzipped).

---

## 9. Common failure modes to deliberately trigger

| Trigger | Expected behavior |
|---|---|
| Kill the server while dashboard is open | Connection overlay appears within ~30s. |
| Delete `.raiken/raiken.db` mid-session | Next query returns gracefully; some panels show empty states. |
| Start with port already in use (`raiken start --port 7101` twice) | Clear error message, exit 1. |
| Run `raiken ci` outside a git repo | Friendly error, exit 2. |
| Run `raiken cover AC-99` referencing a non-existent AC | "Could not resolve target" error. |
| Run `raiken trace` with empty input | "No stack trace provided" + usage hint. |
| Generate a test while offline / API key invalid | Chat shows error bubble with the upstream message; no save. |

---

## 10. Sign-off checklist

- [ ] All CLI commands in §0–§7 return the expected output / write the expected file.
- [ ] Dashboard loads with the purple theme; no stray yellow/amber/blue anywhere.
- [ ] Deep links (`#/quality/doctor` etc.) route correctly.
- [ ] Every view's empty, loading, and error states render without layout shift.
- [ ] Settings persist across `raiken start` restarts.
- [ ] Git hooks install/uninstall without corrupting existing hooks.
- [ ] AI features degrade gracefully when `OPENROUTER_API_KEY` is missing or invalid.

If you find any UI element that still looks "AI-generated" (rounded gradient cards, generic blue, mismatched fonts) — flag it. Otherwise this plan covers every CLI command, every dashboard view, every sub-panel, and the main edge cases.
