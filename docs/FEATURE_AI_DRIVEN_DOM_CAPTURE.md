# Feature: Automated QA Navigation (AI-Driven DOM Capture)

> **Status:** Planned  
> **Priority:** High  
> **Complexity:** High  
> **Dependencies:** Authenticated DOM capture + navigation loop (locator-based, accessibility-like tree)

---

## Executive Summary

Enable Raiken's AI to navigate web applications like a QA engineer, capturing DOM context from multiple pages on-demand during test generation. The AI explores the app with authentication, understands page transitions, and generates tests with accurate selectors based on real DOM structure. Control is user-driven: stop, continue, retry, refine at any time.

---

## Problem Statement

### Current Limitation
Single-page DOM capture is insufficient for E2E tests that span multiple pages:
- Login → Dashboard → Settings → Action
- Product List → Product Detail → Cart → Checkout
- Home → Search → Results → Item

### Impact
- Tests generated without full context have wrong selectors
- AI guesses navigation instead of knowing it
- Users must manually provide every URL
- Tests fail because they don't reflect real user journeys

---

## Solution: AI-Driven On-Demand Capture

The AI captures DOM as it navigates, building context for accurate test generation.

### Core Principles

| Principle | Description |
|-----------|-------------|
| **On-demand** | Capture happens during test generation, not as separate step |
| **AI-driven** | AI decides what to click/navigate based on user intent + tool routing |
| **Never assume** | When uncertain, ask the user for guidance |
| **Accumulative** | Each page's DOM is collected for full flow context |
| **User-controlled** | Stop/continue/retry/refine at any time |
| **Memory-backed** | Persist goal, last action, last URL, and DOM summary |

---

## Control & Tool Routing

The system treats control as first-class. Every user message produces a structured intent envelope that drives routing:

```json
{
  "control": "stop | go | retry | continue | refine | clarify | cancel | new",
  "intent": "test-generation | chat | help",
  "nextTool": "domCapture | codeSearch | testGen | explain | none",
  "effectivePrompt": "string",
  "files": ["optional file hints"]
}
```

- **control** determines whether to stop, continue, retry, or refine.
- **nextTool** selects the next action without hardcoding the flow.
- **effectivePrompt** ensures “try again” reuses the last real task.

## User Experience

### Happy Path

```
User: "test the counter after clicking settings"

AI: Navigating to http://localhost:3000...
    Captured: Home page
    
AI: Looking for path to "settings"...
    Found: "Settings" button in navigation
    Navigating: clicking "Settings" button...
    
AI: Captured: Settings page
    Found: Counter component
    
AI: Generating test with context from 2 pages...

[Generates test with accurate selectors for both pages]
```

### Stuck Path (HITL)

```
User: "test the admin panel"

AI: Navigating to http://localhost:3000...
    Captured: Dashboard page
    
AI: I'm on "Dashboard" but I'm not sure how to reach the admin panel.

    **Current page:** http://localhost:3000/dashboard
    **Elements I see:** Profile, Settings, Logout, Reports
    
    How should I proceed?

User: "click the user avatar, then select Admin from the dropdown"

AI: Navigating: clicking user avatar...
    Navigating: clicking "Admin" in dropdown...
    Captured: Admin Panel
    
AI: Generating test...
```

---

## Technical Architecture

### System Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Message                              │
│              "test the counter after clicking settings"          │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Orchestrator                             │
│  - Detects intent: test-generation                               │
│  - Identifies target: counter                                    │
│  - Triggers navigation capture                                   │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Navigation Capture Loop                       │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │ Capture DOM  │───▶│ AI Analyzes  │───▶│ Has Target?  │       │
│  │ (snapshot)   │    │ Page + Intent│    │              │       │
│  └──────────────┘    └──────────────┘    └──────┬───────┘       │
│         ▲                                        │               │
│         │                              ┌─────────┴─────────┐     │
│         │                              │                   │     │
│         │                             Yes                  No    │
│         │                              │                   │     │
│         │                              ▼                   ▼     │
│         │                    ┌──────────────┐    ┌──────────────┐│
│         │                    │Return DOMs   │    │Suggest Action││
│         │                    │for Test Gen  │    │or Ask User   ││
│         │                    └──────────────┘    └──────┬───────┘│
│         │                                               │        │
│         │                                               ▼        │
│         │                                      ┌──────────────┐  │
│         └──────────────────────────────────────│Execute Action│  │
│                                                │(click/fill)  │  │
│                                                └──────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Test Generation Agent                       │
│  - Receives DOM snapshots from all visited pages                 │
│  - Generates test with accurate selectors                        │
│  - Includes navigation steps in test                             │
└─────────────────────────────────────────────────────────────────┘
```

### Data Structures

```typescript
// DOM snapshot from a single page
interface DOMSnapshot {
  url: string;
  title: string;
  accessibilityTree: AccessibilityNode;
  timestamp: number;
}

// Result of navigation analysis
interface NavigationAnalysis {
  hasTarget: boolean;           // Found what user wants to test
  action?: NavigationAction;    // Suggested next action
  needsUserInput: boolean;      // AI is stuck, needs guidance
  availableActions: string[];   // What AI sees it could do
  reasoning: string;            // Why AI made this decision
}

// Action to execute
interface NavigationAction {
  type: 'click' | 'fill' | 'goto' | 'wait';
  selector?: string;    // For click/fill
  value?: string;       // For fill
  url?: string;         // For goto
  description: string;  // Human-readable
}

// Navigation session state
interface NavigationState {
  snapshots: DOMSnapshot[];
  visitedUrls: Set<string>;
  stepCount: number;
  maxSteps: number;
  userIntent: string;
}

// Playwright accessibility node (from page.accessibility.snapshot())
interface AccessibilityNode {
  role: string;
  name?: string;
  value?: string;
  description?: string;
  checked?: boolean;
  pressed?: boolean;
  level?: number;
  children?: AccessibilityNode[];
}
```

### Key Functions

```typescript
// Start/reuse browser session
async function getBrowserPage(options?: {
  storageState?: string;
}): Promise<Page>;

// Capture current page DOM
async function captureCurrentPage(page: Page): Promise<DOMSnapshot>;

// Execute navigation action
async function executeAction(
  page: Page, 
  action: NavigationAction
): Promise<void>;

// AI analyzes page and decides next step
async function analyzePageAndDecideAction(
  snapshot: DOMSnapshot,
  userIntent: string,
  previousSnapshots: DOMSnapshot[],
  config: AgentConfig
): Promise<NavigationAnalysis>;

// Main navigation loop (generator for streaming)
async function* captureWithNavigation(
  userIntent: string,
  startUrl: string,
  config: AgentConfig
): AsyncGenerator<string | DOMSnapshot[], void, unknown>;

// Close browser session
async function closeBrowser(): Promise<void>;
```

---

## Guardrails & Safety

### Limits

| Guardrail | Value | Purpose |
|-----------|-------|---------|
| Max navigation steps | 5 | Prevent infinite loops |
| Step timeout | 30 seconds | Catch hung pages |
| Action whitelist | click, fill, goto, wait | Prevent dangerous actions |
| Loop detection | Track visited URLs | Don't revisit same page |

### Error Handling

| Error | Recovery |
|-------|----------|
| Page fails to load | Return partial snapshots, ask user |
| Action fails (element not found) | Report to user, ask for guidance |
| Max steps reached | Return what we have, explain to user |
| Unexpected page (redirect) | Capture it, ask user if expected |
| Browser crash | Restart browser, resume from last URL |

### Never Assume

The AI must ask the user when:
- Multiple navigation paths exist
- Target not clearly visible
- Page content is ambiguous
- Action fails
- Unexpected page appears
- Max steps approaching

---

## Authentication Support

### Storage State

Playwright's `storageState` captures cookies, localStorage, sessionStorage.

```typescript
// Capture auth state (separate command)
await context.storageState({ path: '.raiken/auth.json' });

// Reuse auth state
const context = await browser.newContext({
  storageState: '.raiken/auth.json',
});
```

### Auth Flow

1. User runs `raiken auth --url http://localhost:3000/login`
2. Browser opens, user logs in manually
3. Auth state saved to `.raiken/auth.json`
4. All subsequent captures use this auth state
5. User already logged in when navigation starts

---

## AI Prompt Design

### Navigation Analysis Prompt

```
You are navigating a web application to find the right page for test generation.

**User wants to test:** {userIntent}

**Current page:**
URL: {currentUrl}
Title: {pageTitle}

**Accessibility Tree:**
{accessibilityTree}

**Pages already visited:** {previousPages}

**Your task:**
1. Does this page contain what the user wants to test?
2. If yes, set hasTarget = true
3. If no, what action should I take to get there?
4. If unsure, set needsUserInput = true - never guess

**Rules:**
- Only suggest actions based on elements you see in the accessibility tree
- If multiple paths seem possible, ask the user
- If you don't see a clear path, ask the user
- Use exact names from the accessibility tree for selectors

**Response format:**
{
  "hasTarget": boolean,
  "needsUserInput": boolean,
  "action": { "type": "click|fill|goto", "selector": "...", "description": "..." },
  "availableActions": ["list of elements user could interact with"],
  "reasoning": "why you made this decision"
}
```

---

## Test Generation with Multi-Page Context

When test generation receives multiple DOM snapshots:

```typescript
const testPrompt = `
Generate a Playwright test for: "${userIntent}"

**Navigation flow captured:**

[Page 1: ${snapshots[0].url}]
${formatAccessibilityTree(snapshots[0].accessibilityTree)}

[Page 2: ${snapshots[1].url}]
${formatAccessibilityTree(snapshots[1].accessibilityTree)}

**Generate test that:**
1. Starts at ${snapshots[0].url}
2. Navigates through the captured pages
3. Uses selectors from the accessibility trees above
4. Ends with assertions on the target functionality
`;
```

### Generated Test Example

```typescript
import { test, expect } from '@playwright/test';

test.describe('Counter after Settings', () => {
  test('should display counter on settings page', async ({ page }) => {
    // Navigate to home
    await page.goto('http://localhost:3000');
    
    // Click settings (from Page 1 DOM)
    await page.getByRole('button', { name: 'Settings' }).click();
    
    // Verify counter exists (from Page 2 DOM)
    await expect(page.getByRole('spinbutton', { name: 'Counter' })).toBeVisible();
    
    // Interact with counter
    await page.getByRole('button', { name: 'Increment' }).click();
    await expect(page.getByRole('spinbutton', { name: 'Counter' })).toHaveValue('1');
  });
});
```

---

## Implementation Phases

### Phase 1: Basic DOM Capture (Implement Now)
- [x] Replace manual extraction with `page.accessibility.snapshot()`
- [x] Add `storageState` support
- [ ] Update `formatDOMContext` for accessibility tree

### Phase 2: Navigation Infrastructure
- [ ] Add browser session management (persistent page)
- [ ] Add `executeAction` function
- [ ] Add visited URL tracking

### Phase 3: AI Navigation Loop
- [ ] Add `analyzePageAndDecideAction` with AI call
- [ ] Add `captureWithNavigation` generator
- [ ] Integrate with orchestrator

### Phase 4: HITL & Polish
- [ ] Handle user guidance in chat flow
- [ ] Add guardrails (max steps, timeouts)
- [ ] Add error recovery
- [ ] Add `raiken auth` command

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Multi-page test accuracy | >80% of selectors work first try |
| Navigation success rate | >90% reach target within 5 steps |
| User intervention rate | <20% of flows need guidance |
| Time to generate multi-page test | <30 seconds for 3-page flow |

---

## Open Questions

1. **Should we cache DOM snapshots?** Could speed up repeated test generation for same pages.

2. **How to handle SPAs with same URL but different state?** May need to track state, not just URL.

3. **Should AI be able to scroll/hover?** Some elements only visible after scroll.

4. **How to handle iframes?** Playwright can, but adds complexity.

5. **Should we support multiple browser contexts?** For testing different user roles.

---

## References

- [Playwright Accessibility API](https://playwright.dev/docs/accessibility-testing)
- [Playwright Storage State](https://playwright.dev/docs/auth#reuse-signed-in-state)
- [Accessibility Tree Spec](https://www.w3.org/TR/accname-1.2/)
