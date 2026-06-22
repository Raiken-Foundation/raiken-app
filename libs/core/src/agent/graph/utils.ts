export type AgentIntent = "explore" | "generateTests" | "explain";

export type InterruptionType =
    | "auth"
    | "otp"
    | "captcha"
    | "paywall"
    | "error"
    | "consent"
    | "unknown";

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
}

export interface Credentials {
    username?: string;
    email?: string;
    password?: string;
    code?: string;
    useDefaults: boolean;
}

export interface SummaryElement {
    role: string;
    name: string;
    type?: string;
    /** First/primary selector (for backward compat) */
    selector?: string;
    /** All DOM-derived selectors for this element */
    selectors: string[];
}

export function extractUrlFromText(text: string): string | undefined {
    const match = text.match(/https?:\/\/[^\s)]+/i);
    return match ? match[0] : undefined;
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
        const match = line.match(/^•\s+([^:]+):\s+"(.*)"(?:\s+\[type=(\S+)\])?$/);
        if (!match) {
            continue;
        }
        const role = match[1].trim();
        const name = match[2].trim();
        const type = match[3] || undefined;
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

    return {
        hasPasswordField,
        hasEmailOrUserField,
        hasCodeField,
        hasBlockingOverlay,
        isDeadEnd: elements.length <= 3,
        elementCount: elements.length,
        pageTitle,
        passwordSelectors: collectSelectors(passwordEl),
        identitySelectors: hasPasswordField ? collectSelectors(identityEl) : [],
        codeFieldSelectors: collectSelectors(codeEl),
    };
}

/**
 * Decide whether the page warrants an LLM classification call.
 * This is intentionally generous (some false triggers are fine) to avoid
 * missing real blockers. The LLM will filter out non-blockers.
 */
export function shouldClassifyInterruption(signals: StructuralSignals): boolean {
    if (signals.hasPasswordField) return true;
    if (signals.hasCodeField) return true;
    if (signals.hasBlockingOverlay) return true;
    if (signals.isDeadEnd) return true;
    return false;
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
    return lines.length > 0 ? lines.join("\n") : "Exploration complete.";
}
