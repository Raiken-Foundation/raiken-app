export type AgentIntent = "explore" | "generateTests" | "explain";
export type AuthPrecondition = "authenticated" | "unauthenticated" | "login_flow";
export type DiscoveryManagementAction = "clear" | "start" | "clearAndStart";

export type InterruptionType =
    | "auth"
    | "otp"
    | "captcha"
    | "paywall"
    | "error"
    | "consent"
    | "unknown";

/**
 * A single input field the page is asking the user to fill. Enumerated
 * directly from the DOM so it works for arbitrary credentials (a PIN, an
 * employee number, a one-off code, email + password, etc.) rather than a
 * fixed username/password schema.
 */
export interface RequestedField {
    /** Stable key used to correlate the field with a user-provided value. */
    key: string;
    /** Human-readable label (from name/placeholder) shown to the user. */
    label: string;
    /** HTML input type, when known (e.g. "password", "tel", "email"). */
    type?: string;
    /** DOM-derived selectors used to fill the field. */
    selectors: string[];
}

export interface InterruptionInfo {
    type: InterruptionType;
    message: string;
    requiresUser: boolean;
    actionSelector?: string;
    fieldSelectors?: {
        username?: string[];
        email?: string[];
        password?: string[];
        code?: string[];
        submit?: string[];
    };
    /** DOM-derived fields the page is requesting (dynamic, label-driven). */
    requestedFields?: RequestedField[];
    /** Selectors for the primary submit/continue button, if any. */
    submitSelectors?: string[];
}

export interface SummaryElement {
    role: string;
    name: string;
    type?: string;
    /** Link target (for anchors/links), when present in the DOM summary. */
    href?: string;
    /** First/primary selector (for backward compat) */
    selector?: string;
    /** All DOM-derived selectors for this element */
    selectors: string[];
}

/**
 * LLM plan for what context to assemble before generating a test. Produced by
 * the context-planner step so gathering is deliberate (targeted code queries +
 * DOM aspects) rather than a single blind semantic search.
 */
export interface ContextPlan {
    /** Focused code-search queries to run against the code graph. */
    searchQueries: string[];
    /** Specific file paths the model expects to be relevant (may be empty). */
    focusFiles: string[];
    /** Which live-DOM aspects matter (forms, validation, async states, …). */
    domAspects: string[];
    /** One-line rationale for what was gathered and why. */
    rationale: string;
}

/**
 * Outcome of a goal-directed action search (e.g. the user asked the agent to
 * "sign out"). Recorded so the graph can report the exact path taken and so
 * test generation can reproduce it.
 */
export interface ActionResult {
    /** The action phrase we were hunting for (e.g. "sign out"). */
    action: string;
    /** Whether a matching control was located. */
    found: boolean;
    /** Whether the control was actually clicked. */
    performed: boolean;
    /** URL of the page where the control was found. */
    page: string | null;
    /** DOM-derived selector that was clicked (primary). */
    selector: string | null;
    /** How we got there (e.g. "opened user menu -> clicked Sign out"). */
    note: string;
}

// Common action synonyms so "sign out" also matches "log out", "logout", etc.
// Each group is a set of interchangeable phrases; a user action matches an
// element when they share a group or the element name contains the action.
const ACTION_SYNONYM_GROUPS: string[][] = [
    ["sign out", "signout", "sign-out", "log out", "logout", "log-out", "sign off", "signoff"],
    ["sign in", "signin", "sign-in", "log in", "login", "log-in"],
    ["sign up", "signup", "sign-up", "register", "create account"],
    ["add to cart", "add to bag", "add to basket"],
    ["delete", "remove", "trash"],
    ["save", "submit", "confirm", "apply"],
    ["edit", "update", "modify"],
    ["settings", "preferences", "account settings"],
    ["profile", "account", "my account"],
];

function normalizeActionText(text: string): string {
    return text.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Expand an action phrase into the set of interchangeable phrases to match
 * against element names. Always includes the action itself.
 */
export function expandActionSynonyms(action: string): string[] {
    const norm = normalizeActionText(action);
    const set = new Set<string>([norm]);
    for (const group of ACTION_SYNONYM_GROUPS) {
        if (group.some((phrase) => norm.includes(phrase) || phrase.includes(norm))) {
            for (const phrase of group) set.add(phrase);
        }
    }
    return Array.from(set).filter(Boolean);
}

/**
 * Does an element name/label match the requested action (synonym-aware)?
 */
export function matchesAction(elementName: string, action: string): boolean {
    if (!elementName || !action) return false;
    const name = normalizeActionText(elementName);
    if (!name) return false;
    return expandActionSynonyms(action).some(
        (phrase) => phrase.length > 0 && name.includes(phrase),
    );
}

/**
 * Normalize a URL for visited-set dedup during exploration: drop the hash and
 * any trailing slash so `/settings`, `/settings/`, and `/settings#top` are
 * treated as the same page (the source of the "cycling between the same pages"
 * feel). Returns the input unchanged when it is not a parseable URL.
 */
export function normalizeExploreUrl(href: string): string {
    if (!href) return href;
    try {
        const u = new URL(href);
        u.hash = "";
        // Strip trailing slashes from the path, but keep the root "/".
        if (u.pathname !== "/" && u.pathname.endsWith("/")) {
            u.pathname = u.pathname.replace(/\/+$/, "");
        }
        return u.toString();
    } catch {
        const stripped = href.replace(/#.*$/, "").replace(/\/+$/, "");
        return stripped || "/";
    }
}

export function extractUrlFromText(text: string): string | undefined {
    const match = text.match(/https?:\/\/[^\s)]+/i);
    return match ? match[0] : undefined;
}

/**
 * True when the user's goal is to test the UNAUTHENTICATED / login experience
 * itself (e.g. "test the sign-in page", "verify the unauthenticated landing
 * page", "assert the login form is visible — do not assume a logged-in session").
 *
 * In that case a login wall is the TARGET, not a blocker: the agent must keep the
 * captured login DOM and generate a test for it instead of trying to sign in,
 * slip past it with a saved session, or crawl deeper into the identity provider.
 * Without this, an app that gates every route behind auth can never have its
 * login page tested.
 */
export function goalTargetsUnauthedPage(prompt: string): boolean {
    const p = (prompt || "").toLowerCase();

    // 1. Explicit logged-out / unauthenticated intent always wins.
    const explicitUnauthed =
        /\bunauthenticated\b/.test(p) ||
        /\bnot\s+(?:logged|signed)\s+in\b/.test(p) ||
        /\b(?:logged|signed)\s+out\b/.test(p) ||
        /\bwithout\s+(?:signing|logging)\s+in\b/.test(p) ||
        /\bdo\s+not\s+assume\s+a\s+logged[-\s]?in\b/.test(p);
    if (explicitUnauthed) return true;

    // 2. Authenticated intent dominates an incidental login-page mention. Without
    // this, a NEGATED reference ("verify it loads authenticated, NOT the login
    // page") would wrongly suppress the saved session and make every generated
    // test run logged-out — failing on the sign-in redirect.
    const authedIntent =
        /\bauthenticated\b/.test(p) || /\bsigned[-\s]?in\b/.test(p) || /\blogged[-\s]?in\b/.test(p);
    if (authedIntent) return false;

    // 3. Otherwise treat "the login/sign-in/get-started page" as the target only
    // when it is NOT negated (skip "not the login page", "don't land on ...").
    const loginNoun =
        /(?:login|log[-\s]?in|sign[-\s]?in|signin|get[-\s]?started|landing)\s+(?:page|screen|ui|form|experience|flow)/;
    const m = loginNoun.exec(p);
    if (!m) return false;
    const before = p.slice(Math.max(0, m.index - 24), m.index);
    if (
        /\b(?:not|never|avoid|without|isn't|aren't|shouldn't|don't|no longer)\b|n't\s+\w*\s*$/.test(
            before,
        )
    ) {
        return false;
    }
    return true;
}

export interface AuthPreconditionInput {
    userPrompt: string;
    activeGoal?: string | null;
    targetFeature?: string | null;
    targetAction?: string | null;
}

const EXPLICIT_AUTHENTICATED_RE =
    /\b(?:already[-\s]?authenticated|reuse (?:the )?(?:saved )?(?:login )?session|with (?:an? )?(?:saved )?(?:authenticated|logged[-\s]?in|signed[-\s]?in) session|as (?:an? )?(?:authenticated|logged[-\s]?in|signed[-\s]?in) user)\b/i;
// Both patterns match the gerund ("signing in") and the plural
// ("credentials") on purpose. Requiring the bare stem let a plainly
// login-shaped prompt — "test signing in with invalid credentials" — fall
// through every branch to the `authenticated` default, which is precisely the
// failure this precondition exists to prevent: the test would start from a
// saved session with no login form on screen.
const LOGIN_FLOW_RE =
    /\b(?:mfa|otp|2fa|two[-\s]?factor|multi[-\s]?factor|verification code|one[-\s]?time (?:code|password)|credentials?|log(?:ging)?[\s-]?in flow|sign(?:ing)?[\s-]?in flow|authentication flow)\b/i;
const AUTH_TASK_RE =
    /\b(?:auth|authentication|log(?:ging)?[\s-]?in|login|log(?:ging)?[\s-]?out|logout|sign(?:ing)?[\s-]?in|sign(?:ing)?[\s-]?out|sign(?:ing)?[\s-]?up|register|registration|credentials?|session)\b/i;

/**
 * Resolve the browser/test authentication starting condition once per goal.
 * Every browser and generation decision must use this value so live DOM
 * grounding cannot start authenticated while the generated test starts logged
 * out (or vice versa).
 */
/** Strong, unambiguous "the test must start logged out" signals. */
const EXPLICITLY_UNAUTHENTICATED_RE =
    /\bunauthenticated\b|\bnot\s+(?:logged|signed)\s+in\b|\b(?:logged|signed)\s+out\b|\bwithout\s+(?:signing|logging)\s+in\b|\bdo\s+not\s+assume\s+a\s+logged[-\s]?in\b/i;

export function resolveAuthPrecondition(input: AuthPreconditionInput): AuthPrecondition {
    const text = [input.userPrompt, input.activeGoal, input.targetFeature, input.targetAction]
        .filter(Boolean)
        .join(" ");

    if (EXPLICITLY_UNAUTHENTICATED_RE.test(text)) return "unauthenticated";

    if (EXPLICIT_AUTHENTICATED_RE.test(text)) return "authenticated";
    if (LOGIN_FLOW_RE.test(text)) return "login_flow";
    if (goalTargetsUnauthedPage(text)) return "unauthenticated";
    if (AUTH_TASK_RE.test(text)) return "login_flow";
    return "authenticated";
}

export function shouldUseStorageState(precondition: AuthPrecondition): boolean {
    return precondition === "authenticated";
}

/**
 * Cover's one-shot auth classification.
 *
 * The interactive agent can refine a coarse first guess in later graph nodes,
 * but `raiken cover` is a single LLM call with no refinement pass. This
 * resolver therefore honours only the UNambiguous signals and defaults to
 * `authenticated`. The broad AUTH_TASK_RE catch-all is deliberately omitted:
 * it matches bare nouns (`auth`, `session`, `logout`, `register`) that usually
 * describe *signed-in* actions — "session details on the dashboard", "auth
 * guard redirects signed-in users" — and classifying those as `login_flow`
 * would strip `storageState` from tests that must start authenticated.
 */
export function resolveCoverAuthPrecondition(text: string): AuthPrecondition {
    if (EXPLICITLY_UNAUTHENTICATED_RE.test(text)) return "unauthenticated";
    if (LOGIN_FLOW_RE.test(text)) return "login_flow";
    if (goalTargetsUnauthedPage(text)) return "unauthenticated";
    return "authenticated";
}

export function parseSummaryElements(summary: string): SummaryElement[] {
    const elements: SummaryElement[] = [];
    const lines = summary.split("\n");
    let inElements = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith("INTERACTIVE ELEMENTS:")) {
            inElements = true;
            continue;
        }
        if (inElements && line.startsWith("SELECTOR PRIORITY:")) {
            break;
        }
        if (!inElements || !line.startsWith("• ")) {
            continue;
        }
        const match = line.match(
            /^•\s+([^:]+):\s+"(.*?)"(?:\s+\[type=([^\]]+)\])?(?:\s+\[href=([^\]]+)\])?\s*$/,
        );
        if (!match) {
            continue;
        }
        const role = match[1].trim();
        const name = match[2].trim();
        const type = match[3] || undefined;
        const href = match[4] || undefined;
        const nextLine = (lines[i + 1] || "").trim();
        // Parse all selectors (pipe-delimited) or single selector
        const selectorsMatch = nextLine.match(/^Selectors?:\s+(.+)$/);
        const allSelectors = selectorsMatch
            ? selectorsMatch[1]
                  .split(" | ")
                  .map((s) => s.trim())
                  .filter(Boolean)
            : [];
        elements.push({
            role,
            name,
            type,
            href,
            selector: allSelectors[0],
            selectors: allSelectors,
        });
    }
    return elements;
}

export function normalizeSelector(selector?: string): string | undefined {
    if (!selector) return undefined;
    const testIdMatch = selector.match(/getByTestId\(['"](.+?)['"]\)/);
    if (testIdMatch) {
        return `[data-testid="${testIdMatch[1]}"]`;
    }
    const labelMatch = selector.match(/getByLabel\(['"](.+?)['"]\)/);
    if (labelMatch) {
        return `label=${labelMatch[1]}`;
    }
    const placeholderMatch = selector.match(/getByPlaceholder\(['"](.+?)['"]\)/);
    if (placeholderMatch) {
        return `placeholder=${placeholderMatch[1]}`;
    }
    const altMatch = selector.match(/getByAltText\(['"](.+?)['"]\)/);
    if (altMatch) {
        return `alt=${altMatch[1]}`;
    }
    const titleMatch = selector.match(/getByTitle\(['"](.+?)['"]\)/);
    if (titleMatch) {
        return `title=${titleMatch[1]}`;
    }
    const textMatch = selector.match(/getByText\(['"](.+?)['"]\)/);
    if (textMatch) {
        return `text=${textMatch[1]}`;
    }
    const roleMatch = selector.match(
        /getByRole\(['"](.+?)['"]\s*,\s*\{\s*name:\s*['"](.+?)['"]\s*\}\)/,
    );
    if (roleMatch) {
        return `role=${roleMatch[1]}[name="${roleMatch[2]}"]`;
    }
    return selector;
}

export function findSelector(
    elements: SummaryElement[],
    nameRegex: RegExp,
    roles: string[],
): string | undefined {
    for (const el of elements) {
        if (!roles.includes(el.role)) continue;
        if (!nameRegex.test(el.name)) continue;
        return normalizeSelector(el.selector);
    }
    return undefined;
}

/**
 * Extract the page title from a formatted DOM summary.
 */
export function extractPageTitle(summary: string): string {
    const titleMatch = summary.match(/Page Title:\s*(.+)/i);
    return (titleMatch?.[1] || "").trim();
}

// =========================================================================
// Structural Signals (fast pre-filter for LLM interruption classification)
// =========================================================================

export interface StructuralSignals {
    hasPasswordField: boolean;
    hasEmailOrUserField: boolean;
    hasCodeField: boolean;
    /**
     * True when the page exposes ANY fillable input (text, tel, email, number,
     * search, …) — not just password/code. This is what lets the LLM classifier
     * see arbitrary field-based blockers (a bare phone form, a name gate, a
     * custom access field) that the password/code-specific signals miss.
     */
    hasFormInputs: boolean;
    hasBlockingOverlay: boolean;
    isDeadEnd: boolean;
    elementCount: number;
    pageTitle: string;
    passwordSelectors: string[];
    identitySelectors: string[];
    codeFieldSelectors: string[];
}

const INPUT_ROLES = ["textbox", "combobox"];

/**
 * Find a password field by its HTML type attribute (type=password).
 * This is the universal, reliable way to detect password inputs
 * regardless of labels, names, or placeholder text.
 */
function findPasswordElement(elements: SummaryElement[]): SummaryElement | null {
    return elements.find((el) => INPUT_ROLES.includes(el.role) && el.type === "password") || null;
}

/**
 * Find the identity field (email, username, phone, etc.) by looking for
 * the text/email input that appears near a password field. On login forms,
 * this is typically the input immediately before the password field.
 * Falls back to any text/email input if no password field exists.
 */
function findIdentityElement(
    elements: SummaryElement[],
    passwordEl: SummaryElement | null,
): SummaryElement | null {
    const textInputs = elements.filter(
        (el) => INPUT_ROLES.includes(el.role) && el.type !== "password" && el.type !== "checkbox",
    );

    if (passwordEl) {
        const passwordIndex = elements.indexOf(passwordEl);
        // Look for the closest text input before the password field
        let closest: SummaryElement | null = null;
        let closestDistance = Infinity;
        for (const input of textInputs) {
            const idx = elements.indexOf(input);
            const dist = passwordIndex - idx;
            if (dist > 0 && dist < closestDistance) {
                closestDistance = dist;
                closest = input;
            }
        }
        if (closest) return closest;
    }

    // No password field or nothing before it; return the first text input
    return textInputs.length > 0 ? textInputs[0] : null;
}

/**
 * Find a verification code input (OTP). Checked by type first, then
 * by whether it's a short numeric input on a page with few elements.
 */
function findCodeElement(elements: SummaryElement[]): SummaryElement | null {
    // type=tel or type=number on a dead-end page is often an OTP field
    const telOrNumber = elements.find(
        (el) => INPUT_ROLES.includes(el.role) && (el.type === "tel" || el.type === "number"),
    );
    if (telOrNumber && elements.length <= 10) return telOrNumber;

    // Fallback: any textbox whose name/placeholder hints at a code
    return (
        elements.find(
            (el) => INPUT_ROLES.includes(el.role) && /code|otp|verification|token/i.test(el.name),
        ) || null
    );
}

/**
 * Extract structural signals from parsed interactive elements.
 * Uses HTML input types (type=password) rather than label text to
 * identify fields. This works regardless of language or naming conventions.
 */
/**
 * Collect all selectors from a SummaryElement, using every DOM-derived
 * selector that was captured during page collection.
 */
function collectSelectors(el: SummaryElement | null): string[] {
    if (!el) return [];
    return el.selectors.length > 0 ? [...el.selectors] : el.selector ? [el.selector] : [];
}

export function getStructuralSignals(
    elements: SummaryElement[],
    pageTitle: string,
    hasBlockingOverlay = false,
): StructuralSignals {
    const passwordEl = findPasswordElement(elements);
    const identityEl = findIdentityElement(elements, passwordEl);
    const codeEl = findCodeElement(elements);

    const hasPasswordField = passwordEl !== null;
    const hasEmailOrUserField = identityEl !== null && hasPasswordField;
    const hasCodeField = codeEl !== null;
    const hasFormInputs = elements.some(
        (el) => INPUT_ROLES.includes(el.role) && el.type !== "checkbox" && el.type !== "radio",
    );

    return {
        hasPasswordField,
        hasEmailOrUserField,
        hasCodeField,
        hasFormInputs,
        hasBlockingOverlay,
        // A page with zero interactive elements almost always means the
        // capture failed or the page hasn't loaded yet — not a real
        // user-actionable dead-end. Genuine dead-ends (error pages, captcha
        // walls) still expose 1–3 controls like a "Go back" or "Retry"
        // button, so we require at least one element before flagging.
        isDeadEnd: elements.length >= 1 && elements.length <= 3,
        elementCount: elements.length,
        pageTitle,
        passwordSelectors: collectSelectors(passwordEl),
        identitySelectors: hasPasswordField ? collectSelectors(identityEl) : [],
        codeFieldSelectors: collectSelectors(codeEl),
    };
}

/**
 * Decide whether the page warrants an LLM classification call.
 *
 * This is a cheap PRE-FILTER, not the decision itself — the LLM
 * ({@link classifyInterruption}) is what actually decides whether a page is a
 * blocker and what it needs. We keep a filter only to avoid spending an LLM
 * call on pages that clearly can't be a field/blocker (pure content pages with
 * no inputs, no overlay, and plenty of navigation).
 *
 * Crucially it now fires on ANY page with fillable inputs — not just
 * password/code — so arbitrary gated forms (a bare phone number, a name, a
 * custom access field) reach the LLM instead of being silently skipped by the
 * old password/code-only rules.
 */
export function shouldClassifyInterruption(signals: StructuralSignals): boolean {
    if (signals.hasPasswordField) return true;
    if (signals.hasCodeField) return true;
    if (signals.hasFormInputs) return true;
    if (signals.hasBlockingOverlay) return true;
    if (signals.isDeadEnd) return true;
    return false;
}

/**
 * Enumerate every fillable input the page is presenting, with its label, type,
 * and DOM-derived selectors. Unlike the auth-specific signal helpers, this is
 * generic: it captures whatever fields a blocker is asking for so the values
 * the user provides can be mapped onto them dynamically. Checkboxes/radios are
 * excluded since they are toggles, not free-text credential inputs.
 */
export function getRequestedInputFields(elements: SummaryElement[]): RequestedField[] {
    const fields: RequestedField[] = [];
    elements.forEach((el, index) => {
        if (!INPUT_ROLES.includes(el.role)) return;
        if (el.type === "checkbox" || el.type === "radio") return;
        const selectors = collectSelectors(el);
        if (selectors.length === 0) return;
        const label = el.name?.trim() || (el.type ? `${el.type} field` : "field");
        fields.push({ key: `field_${index}`, label, type: el.type, selectors });
    });
    return fields;
}

/**
 * Quick structural check used after login submission to verify the auth
 * form is gone. Does NOT use the LLM -- just checks whether password +
 * email/username fields still exist on the page.
 */
export function hasAuthFormFields(elements: SummaryElement[]): boolean {
    const passwordEl = findPasswordElement(elements);
    if (!passwordEl) return false;
    const identityEl = findIdentityElement(elements, passwordEl);
    return identityEl !== null;
}

export function buildSummary(state: {
    pagesVisited?: string[];
    testDraft?: string | null;
    savedTestPath?: string | null;
    activeGoal?: string | null;
    targetFeature?: string | null;
    targetUrl?: string | null;
    missingContext?: string[];
    nextTool?: string | null;
    /**
     * Locators the captured DOM could not confirm. Structural type (rather than
     * importing `SelectorViolation`) keeps this module dependency-free.
     */
    groundingViolations?: Array<{ locator: string; reason: string }>;
}): string {
    const lines: string[] = [];
    if (state.activeGoal) {
        lines.push(`Active goal: ${state.activeGoal}`);
    }
    if (state.targetFeature) {
        lines.push(`Target feature: ${state.targetFeature}`);
    }
    if (state.targetUrl) {
        lines.push(`Target URL: ${state.targetUrl}`);
    }
    if (state.missingContext && state.missingContext.length > 0) {
        lines.push(`Missing context: ${state.missingContext.join(", ")}`);
    }
    if (state.nextTool) {
        lines.push(`Suggested next tool: ${state.nextTool}`);
    }
    if (state.pagesVisited && state.pagesVisited.length > 0) {
        lines.push(`Visited ${state.pagesVisited.length} pages:`);
        const preview = state.pagesVisited.slice(0, 5).map((url) => `- ${url}`);
        lines.push(...preview);
        if (state.pagesVisited.length > 5) {
            lines.push(`- ...and ${state.pagesVisited.length - 5} more`);
        }
    }
    if (state.testDraft) {
        lines.push("Generated a test draft.");
    }
    if (state.savedTestPath) {
        lines.push(`Saved test to ${state.savedTestPath}.`);
    }
    // Say so rather than logging it: an unconfirmed locator is the most likely
    // reason the test fails on its first run.
    if (state.groundingViolations && state.groundingViolations.length > 0) {
        lines.push(
            `${state.groundingViolations.length} selector(s) could not be confirmed against the captured DOM:`,
        );
        for (const violation of state.groundingViolations.slice(0, 5)) {
            lines.push(`- ${violation.locator} — ${violation.reason}`);
        }
        if (state.groundingViolations.length > 5) {
            lines.push(`- ...and ${state.groundingViolations.length - 5} more`);
        }
    }
    return lines.length > 0
        ? lines.join("\n")
        : "I could not complete an action or produce a grounded result. Please restate the request, or use `/help` to see the actions available in chat.";
}
