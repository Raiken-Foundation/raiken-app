export type AgentIntent = "explore" | "generateTests" | "explain";

export type InterruptionType = "auth" | "otp" | "captcha" | "paywall" | "error" | "consent" | "unknown";

export interface InterruptionInfo {
    type: InterruptionType;
    message: string;
    requiresUser: boolean;
    actionSelector?: string;
    fieldSelectors?: {
        username?: string;
        email?: string;
        password?: string;
        code?: string;
        submit?: string;
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
    selector?: string;
}

export function extractUrlFromText(text: string): string | undefined {
    const match = text.match(/https?:\/\/[^\s)]+/i);
    return match ? match[0] : undefined;
}

export function isTestGenerationRequest(prompt: string): boolean {
    const lowered = prompt.toLowerCase();
    if (/(generate|write|create|build).*(test|tests|spec|specs|playwright)/.test(lowered)) {
        return true;
    }
    if (/playwright/.test(lowered) && /\btest\b/.test(lowered)) {
        return true;
    }
    return false;
}

export function isExplanationRequest(prompt: string): boolean {
    const lowered = prompt.toLowerCase();
    return /\b(explain|understand|walk me through|break down|overview|architecture|what does|how does|why does|describe)\b/.test(
        lowered
    );
}

function isContinuationPrompt(prompt: string): boolean {
    const lowered = prompt.trim().toLowerCase();
    if (!lowered) return false;
    const wordCount = lowered.split(/\s+/).length;
    if (wordCount <= 3 && /^(yes|yeah|yep|ok|okay|sure|cool|great|thanks)$/i.test(lowered)) {
        return true;
    }
    return /\b(go ahead|continue|proceed|do it|do that|same|as before|that works|try again|retry|run it|run them|carry on|please continue)\b/i.test(
        lowered
    );
}

function getLastMeaningfulUserPrompt(
    conversationHistory?: Array<{ role: string; content: string }>
): string | undefined {
    if (!conversationHistory || conversationHistory.length === 0) return undefined;
    for (let i = conversationHistory.length - 1; i >= 0; i -= 1) {
        const msg = conversationHistory[i];
        if (msg.role !== "user") continue;
        const content = msg.content.trim();
        if (!content) continue;
        if (isContinuationPrompt(content)) continue;
        return content;
    }
    return undefined;
}

export function inferIntent(
    userPrompt: string,
    conversationHistory?: Array<{ role: string; content: string }>,
    storedIntent?: AgentIntent | null
): AgentIntent {
    if (isTestGenerationRequest(userPrompt)) return "generateTests";
    if (isExplanationRequest(userPrompt)) return "explain";
    if (!isContinuationPrompt(userPrompt)) return "explore";
    const previousUserPrompt = getLastMeaningfulUserPrompt(conversationHistory);
    if (previousUserPrompt && isTestGenerationRequest(previousUserPrompt)) {
        return "generateTests";
    }
    if (previousUserPrompt && isExplanationRequest(previousUserPrompt)) {
        return "explain";
    }
    if (storedIntent) return storedIntent;
    return "explore";
}

export function shouldRunTests(prompt: string): boolean {
    const lowered = prompt.toLowerCase();
    return /(run|execute|start).*(test|tests|spec|specs)/.test(lowered);
}

export function extractCredentials(
    userPrompt: string,
    conversationHistory?: Array<{ role: string; content: string }>
): Credentials {
    const historyText = conversationHistory?.map((msg) => msg.content).join("\n") || "";
    const combined = `${historyText}\n${userPrompt}`;
    const useDefaults = /use default|default credentials|any credentials|test credentials|use test login/i.test(
        combined
    );

    const sanitizeValue = (value?: string) => value?.replace(/[.,;:)\]]$/, "");
    const extractValue = (patterns: RegExp[]) => {
        for (const pattern of patterns) {
            const match = combined.match(pattern);
            if (match?.[1]) {
                return sanitizeValue(match[1]);
            }
        }
        return undefined;
    };

    const username = extractValue([
        /\busername\b\s*(?:is|=|:)?\s*["']?([^\s,"']+)/i,
        /\buser name\b\s*(?:is|=|:)?\s*["']?([^\s,"']+)/i,
        /\blogin\s+(?:as|with)\s+["']?([^\s,"']+)/i,
        /\bsign in\s+(?:as|with)\s+["']?([^\s,"']+)/i,
        /\blog in\s+(?:as|with)\s+["']?([^\s,"']+)/i,
        /\buser\s*[:=]\s*["']?([^\s,"']+)/i,
        /\busername\b\s+["']?([^\s,"']+)/i,
    ]);

    const email = extractValue([
        /\bemail\b\s*(?:is|=|:)?\s*["']?([^\s,"']+)/i,
        /\bemail\b\s+["']?([^\s,"']+)/i,
        /\blogin\s+with\s+email\s+["']?([^\s,"']+)/i,
    ]);

    const password = extractValue([
        /\bpassword\b\s*(?:is|=|:)?\s*["']?([^\s,"']+)/i,
        /\bpasscode\b\s*(?:is|=|:)?\s*["']?([^\s,"']+)/i,
        /\bpin\b\s*(?:is|=|:)?\s*["']?([^\s,"']+)/i,
    ]);

    const codeMatch = combined.match(/(code|otp|verification)\s*[:=]?\s*([0-9]{4,8})/i);
    const code = codeMatch?.[2];

    return {
        username: username || (useDefaults ? "testuser" : undefined),
        email: email || (useDefaults ? "test@example.com" : undefined),
        password: password || (useDefaults ? "password123" : undefined),
        code,
        useDefaults,
    };
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
        const match = line.match(/^•\s+([^:]+):\s+"(.*)"$/);
        if (!match) {
            continue;
        }
        const role = match[1].trim();
        const name = match[2].trim();
        const nextLine = (lines[i + 1] || "").trim();
        const selectorMatch = nextLine.match(/^Selector:\s+(.+)$/);
        elements.push({
            role,
            name,
            selector: selectorMatch?.[1],
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
    const roleMatch = selector.match(/getByRole\(['"](.+?)['"]\s*,\s*\{\s*name:\s*['"](.+?)['"]\s*\}\)/);
    if (roleMatch) {
        return `role=${roleMatch[1]}[name="${roleMatch[2]}"]`;
    }
    return selector;
}

export function findSelector(elements: SummaryElement[], nameRegex: RegExp, roles: string[]): string | undefined {
    for (const el of elements) {
        if (!roles.includes(el.role)) continue;
        if (!nameRegex.test(el.name)) continue;
        return normalizeSelector(el.selector);
    }
    return undefined;
}

export function detectInterruption(
    summary: string,
    elements: SummaryElement[],
    credentials: Credentials
): InterruptionInfo | null {
    const lowered = summary.toLowerCase();

    if (/captcha|robot|unusual traffic|verify you are human/.test(lowered)) {
        return {
            type: "captcha",
            message: "Captcha detected. Please complete it and let me know when to continue.",
            requiresUser: true,
        };
    }

    if (/paywall|subscribe|subscription|upgrade|purchase|pricing/.test(lowered)) {
        return {
            type: "paywall",
            message: "Paywall or subscription prompt detected. Please resolve it and let me know when to continue.",
            requiresUser: true,
        };
    }

    if (/error|maintenance|unavailable|access denied|forbidden|something went wrong/.test(lowered)) {
        return {
            type: "error",
            message: "An error or maintenance message is blocking progress. Please resolve it and let me know when to continue.",
            requiresUser: true,
        };
    }

    const hasConsent = /cookie|consent|privacy/.test(lowered);
    if (hasConsent) {
        const consentSelector = findSelector(elements, /(accept|agree|allow|ok|continue|close|dismiss)/i, ["button"]);
        return {
            type: "consent",
            message: "Cookie consent detected. Attempting to resolve automatically.",
            requiresUser: !consentSelector,
            actionSelector: consentSelector,
        };
    }

    const otpSelector = findSelector(elements, /(code|otp|verification)/i, ["textbox", "combobox"]);
    if (/verification code|one-time|otp|two-factor|2fa|security code/.test(lowered) || otpSelector) {
        return {
            type: "otp",
            message: "Verification code required. Please provide the code.",
            requiresUser: !credentials.code,
            fieldSelectors: {
                code: otpSelector,
                submit: findSelector(
                    elements,
                    /(verify|submit|continue|confirm|login|sign in)/i,
                    ["button"]
                ),
            },
        };
    }

    const passwordSelector = findSelector(elements, /(password|passcode|pin)/i, ["textbox", "combobox"]);
    const authSelector = findSelector(elements, /(email|username|user name|password)/i, [
        "textbox",
        "combobox",
    ]);
    if (/login|log in|sign in|password|username|email/.test(lowered) || authSelector) {
        const needsUsernameOrEmail = !credentials.username && !credentials.email;
        const needsPassword = Boolean(passwordSelector && !credentials.password);
        return {
            type: "auth",
            message: "Authentication required.",
            requiresUser: (needsUsernameOrEmail || needsPassword) && !credentials.useDefaults,
            fieldSelectors: {
                username: findSelector(elements, /(username|user name|name)/i, ["textbox", "combobox"]),
                email: findSelector(elements, /email/i, ["textbox", "combobox"]),
                password: passwordSelector,
                submit: findSelector(
                    elements,
                    /(login|log in|sign in|continue|submit|confirm)/i,
                    ["button"]
                ),
            },
        };
    }

    if (/dialog|modal|overlay/.test(lowered)) {
        return {
            type: "unknown",
            message: "A blocking dialog or overlay was detected. Please resolve it and let me know when to continue.",
            requiresUser: true,
        };
    }

    return null;
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
