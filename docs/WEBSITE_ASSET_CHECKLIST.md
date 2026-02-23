# Website Asset Checklist (Docs + Marketing)

This checklist is designed for fast handoff to design/content teams. It gives exact asset names, dimensions, placement targets, and capture intent.

Note: the target paths you listed (`src/content/docs/...`, `src/pages/...`) do not exist in this repository, so this file is prepared as a drop-in plan for your website/docs repo.

---

## 1) Global Asset Standards

## File format

- **Screenshots:** `.png` (preferred), `.webp` optional if your site pipeline supports it.
- **Animated demos:** `.gif` for simple loops; `.mp4` + poster image if you need better quality/perf.

## Resolution and quality

- **Docs inline screenshots:** `1600x1000` (desktop), export at 2x and scale down in site.
- **Hero/marketing stills:** `1920x1080`.
- **Tall dashboard panels:** `1600x1200`.
- Keep text in screenshots readable at `max-width: 900px`.

## Naming convention

- Prefix by area and order: `docs-01-...`, `docs-02-...`, `mkt-01-...`
- Use kebab case and semantic names.
- Example: `docs-03-cli-auth-paused-state.png`

## Recommended folder layout (website repo)

```text
src/assets/images/docs/
src/assets/images/marketing/
src/assets/images/shared/
```

---

## 2) Highest Priority Assets

## A) `src/content/docs/dashboard.md` (Discovery runtime panel)

### Required assets

1. `docs-01-dashboard-discovery-runtime-overview.png`  
   - **Size:** `1600x1000`  
   - **Shows:** phase badge (`running` or `paused`), timeline, action buttons (`Start`, `Continue`, `Auth Assist`, `Clear`), pages table, blockers table.  
   - **Placement:** first image under "Discovery runtime panel".

2. `docs-02-dashboard-discovery-paused-auth.png`  
   - **Size:** `1600x1000`  
   - **Shows:** paused auth state with blocker rows and auth-assist command visible.  
   - **Placement:** in auth-related subsection.

### Alt text

- "Raiken dashboard Discovery panel showing runtime phase, timeline, and controls."
- "Discovery paused on authentication with unresolved blockers and auth-assist command."

---

## B) `src/content/docs/site-discovery.md` (`Runtime model`, `Pause and continue behavior`, `Authentication lifecycle`)

### Required assets

1. `docs-03-site-discovery-runtime-flow-diagram.png`  
   - **Size:** `1800x900`  
   - **Type:** diagram  
   - **Shows:** `idle -> running -> paused -> completed/error`, plus continue branch from paused.

2. `docs-04-site-discovery-paused-state-dashboard.png`  
   - **Size:** `1600x1000`  
   - **Shows:** paused dashboard state with blocker details and next actions.

3. `docs-05-site-discovery-resume-success.png`  
   - **Size:** `1600x1000`  
   - **Shows:** resumed or completed state after auth.

### Alt text

- "Discovery runtime state machine with pause/resume and completion paths."
- "Paused discovery session requiring authentication."
- "Discovery resumed after authentication and completed successfully."

---

## C) `src/content/docs/getting-started.md` (`Run your first discovery`, `Generate your first test`)

### Required assets

1. `docs-06-getting-started-terminal-discover-auth.txt.png`  
   - **Size:** `1600x900`  
   - **Shows:** terminal run with `raiken discover ... --auth` start output.

2. `docs-07-getting-started-dashboard-post-discovery.png`  
   - **Size:** `1600x1000`  
   - **Shows:** dashboard state after discovery completes.

3. `docs-08-getting-started-test-generation-first-run.png`  
   - **Size:** `1600x1000`  
   - **Shows:** testing view with generated test + run/save flow.

### Placement notes

- Put terminal screenshot directly under command block.
- Put dashboard screenshot after "What success looks like".

---

## D) `src/content/docs/cli.md` (`raiken discover`, `raiken auth`)

### Required assets (output-focused)

1. `docs-09-cli-discover-start-output.png`  
   - **Size:** `1600x900`  
   - **Shows:** startup summary (URL, max pages/depth, timeout, auth mode).

2. `docs-10-cli-auth-block-paused-output.png`  
   - **Size:** `1600x900`  
   - **Shows:** auth blocked pause output and next-step instructions.

3. `docs-11-cli-continue-output.png`  
   - **Size:** `1600x900`  
   - **Shows:** continue command output, progress updates.

4. `docs-12-cli-completion-summary-output.png`  
   - **Size:** `1600x900`  
   - **Shows:** completion summary and stats.

### Alt text

- "CLI discovery start output with configuration summary."
- "CLI authentication pause output with resume instructions."
- "CLI continue output showing resumed discovery."
- "CLI completion summary with discovered pages and links."

---

## 3) Medium Priority Assets

## E) `src/content/docs/dom-capture.md` (`What gets captured`)

### Required assets

1. `docs-13-dom-capture-login-annotated.png`  
   - **Size:** `1600x1000`  
   - **Shows:** login page with callouts mapping:
     - heading/link/button
     - selector source (`data-testid`, `href`, text fallback)
     - snapshot/selector fields.

2. `docs-14-dom-capture-snapshot-example.png`  
   - **Size:** `1600x1000`  
   - **Shows:** side-by-side view of page and sample snapshot payload snippet.

---

## F) `src/content/docs/configuration.md` (`Discovery settings`)

### Required assets

1. `docs-15-config-discovery-block-example.png`  
   - **Size:** `1600x900`  
   - **Shows:** realistic `raiken.config.json` discovery block.

2. `docs-16-config-timeout-override-scenario.png`  
   - **Size:** `1600x900`  
   - **Shows:** config default vs CLI override example (`--timeout`).

---

## G) `src/content/docs/troubleshooting.md` (`Discovery paused on authentication`)

### Required assets

1. `docs-17-troubleshooting-paused-auth-state.png`  
   - **Size:** `1600x1000`  
   - **Shows:** paused runtime + blockers.

2. `docs-18-troubleshooting-recovery-sequence.png`  
   - **Size:** `1600x900`  
   - **Shows:** compact sequence:
     - `raiken auth --url ...`
     - `raiken discover --continue`
     - completed state.

---

## 4) Marketing Pages (Proof Visuals)

## H) `src/pages/index.astro` (hero / "How it works")

### Required assets

1. `mkt-01-how-it-works-flow.gif`  
   - **Size:** `1400x840` (or `1280x768`)  
   - **Duration:** 8-14 seconds loop  
   - **Shows:** prompt -> streaming output -> save/run approval.

2. `mkt-02-dashboard-discovery-proof.png`  
   - **Size:** `1920x1080`  
   - **Shows:** polished dashboard discovery panel with timeline and stats.

## I) `src/pages/waitlist.astro`

### Required assets

1. `mkt-03-waitlist-social-proof-dashboard.png`  
   - **Size:** `1600x1000`  
   - **Shows:** discovery timeline and runtime evidence near signup form.

---

## 5) Content Consistency Checklist

When adding visuals, align page copy with current product behavior:

- Remove/adjust "not yet built" claims if auth/discovery helpers are now implemented.
- Verify terminology matches docs:
  - "Discovery runtime"
  - "Pause and continue"
  - "Auth Assist"
  - "Verified links"
- Ensure CLI snippets reflect current flags (`--timeout`, `--auth`, `--continue`, `--status`).

Pages to reconcile first:

- `src/pages/index.astro`
- `src/pages/features.astro`
- `src/pages/waitlist.astro`

---

## 6) Capture Script (for reproducible screenshots)

Use this sequence to generate most docs visuals consistently:

1. Start backend and dashboard:
   - `pnpm nx serve cli`
   - `pnpm nx serve dashboard`
2. Start playground:
   - `cd tools/playground && npm run dev -- --port 5173`
3. Open:
   - dashboard: `http://localhost:4200`
   - playground: `http://localhost:5173`
4. For paused-auth shots:
   - start discovery against playground without prior auth state
5. For resumed/completed shots:
   - run `raiken auth --url http://localhost:5173/login`
   - continue discovery

Capture settings:

- Browser zoom: 100%
- Viewport: `1440x900` or `1600x1000`
- Use dark/light theme consistently per page
- Hide unrelated tabs/toolbars where possible

---

## 7) Final Delivery Checklist

- [ ] All highest-priority assets captured and named as above.
- [ ] All images optimized (<500 KB for docs screenshots where possible).
- [ ] Alt text added for each image.
- [ ] Marketing copy reconciled with implemented behavior.
- [ ] CLI output screenshots reflect current command syntax.
- [ ] Broken links check run in website build preview.

