import { BrowserSession } from "../../../browser/session";
import { AgentMemory } from "../../memory";
import type { GraphStateType } from "../state";
import {
    extractPageTitle,
    getStructuralSignals,
    hasAuthFormFields,
    parseSummaryElements,
    shouldClassifyInterruption,
} from "../utils";
import { classifyInterruption, extractCredentialsWithLLM } from "./classify-interruption";
import type { AgentNodeDeps } from "./types";

const AUTH_INTERRUPTION_TYPES = new Set(["auth", "otp"]);

/**
 * Fill an input using DOM-derived selectors. The full array is passed
 * directly to the session which tries each one. Every selector was
 * built from a real attribute on the element.
 */
async function tryFillWithSelectors(
    callTool: AgentNodeDeps["callTool"],
    selectors: string[],
    value: string,
): Promise<boolean> {
    if (selectors.length === 0) return false;
    const r = await callTool("fillInput", { selector: selectors, value });
    return r.success;
}

/**
 * Click an element using DOM-derived selectors. The full array is passed
 * directly to the session which tries each one.
 */
async function tryClickWithSelectors(
    callTool: AgentNodeDeps["callTool"],
    selectors: string[],
): Promise<boolean> {
    if (selectors.length === 0) return false;
    const r = await callTool("clickElement", { selector: selectors });
    return r.success;
}

export const createDetectInterruptionNode =
    ({ callTool, projectPath, model }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        let summary = state.domSummary;
        if (!summary) {
            if (state.targetUrl) {
                const nav = await callTool("navigateTo", { url: state.targetUrl });
                if (nav.success) {
                    summary = (nav.data as { summary?: string } | undefined)?.summary || null;
                } else {
                    summary = `[Navigation failed: ${nav.message || "unknown error"}]`;
                }
            } else {
                const capture = await callTool("captureCurrentPage", {});
                if (capture.success) {
                    summary = (capture.data as { summary?: string } | undefined)?.summary || null;
                } else {
                    summary = `[Capture failed: ${capture.message || "unknown error"}]`;
                }
            }
        }

        let interruption = null;
        if (summary) {
            const elements = parseSummaryElements(summary);
            const pageTitle = extractPageTitle(summary);

            let hasOverlay = false;
            try {
                const session = BrowserSession.getInstance(projectPath);
                hasOverlay = await session.hasBlockingOverlay();
            } catch {
                /* browser not active */
            }

            const signals = getStructuralSignals(elements, pageTitle, hasOverlay);

            if (shouldClassifyInterruption(signals)) {
                const credentials = await extractCredentialsWithLLM(
                    state.userPrompt,
                    state.conversationHistory,
                    model,
                );
                interruption = await classifyInterruption(
                    pageTitle,
                    elements,
                    signals,
                    credentials,
                    model,
                );
            }
        }

        try {
            const memory = AgentMemory.getInstance(projectPath);
            const pauseReason = memory.getPreference("paused_reason");
            if (pauseReason) {
                memory.setPreference("paused_reason", "");
                if (!interruption && AUTH_INTERRUPTION_TYPES.has(pauseReason)) {
                    await callTool("saveAuthState", {});
                }
            }
        } catch {
            // Memory not available
        }

        return {
            domSummary: summary,
            interruption,
        };
    };

/**
 * After submitting auth credentials, wait for the page to navigate away
 * from the login page before saving auth state.
 *
 * Uses a structural check (are password + email fields still present?)
 * instead of an LLM call, since we already know this WAS an auth page
 * and just need to confirm the form is gone.
 */
async function verifyAuthAndSave(
    callTool: AgentNodeDeps["callTool"],
    loginUrl: string | null,
): Promise<{ verified: boolean; summary: string | null; url: string | null }> {
    for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise((r) => setTimeout(r, 2000));
        const capture = await callTool("captureCurrentPage", {});
        if (!capture.success) continue;

        const newUrl = (capture.data as { url?: string } | undefined)?.url || null;
        const newSummary = (capture.data as { summary?: string } | undefined)?.summary || null;

        const urlChanged = loginUrl && newUrl && newUrl !== loginUrl;
        const authFieldsGone = newSummary
            ? !hasAuthFormFields(parseSummaryElements(newSummary))
            : true;

        if (urlChanged || authFieldsGone) {
            await callTool("saveAuthState", {});
            return { verified: true, summary: newSummary, url: newUrl };
        }
    }
    return { verified: false, summary: null, url: null };
}

export const createResolveInterruptionNode =
    ({ callTool, model }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        const interruption = state.interruption;
        if (!interruption) return {};
        const credentials = await extractCredentialsWithLLM(
            state.userPrompt,
            state.conversationHistory,
            model,
        );

        if (interruption.type === "consent" && interruption.actionSelector) {
            const click = await callTool("clickElement", { selector: interruption.actionSelector });
            if (!click.success) {
                return {
                    shouldPause: true,
                    awaitUserMessage: `Could not dismiss consent banner (selector failed: ${click.message || "unknown"}). Please dismiss it manually and continue.`,
                };
            }
            return {};
        }

        if (interruption.type === "auth") {
            const identitySelectors =
                interruption.fieldSelectors?.username || interruption.fieldSelectors?.email || [];
            const passwordSelectors = interruption.fieldSelectors?.password || [];
            const submitSelectors = interruption.fieldSelectors?.submit || [];

            const needsUsernameOrEmail =
                !credentials.username && !credentials.email && !credentials.useDefaults;
            const needsPassword =
                passwordSelectors.length > 0 && !credentials.password && !credentials.useDefaults;
            if (needsUsernameOrEmail || needsPassword) {
                return {
                    shouldPause: true,
                    awaitUserMessage:
                        "Authentication required. Please provide credentials to continue.",
                };
            }

            let interactionFailed = false;

            const identityValue = credentials.username || credentials.email;
            if (identityValue && identitySelectors.length > 0) {
                const r = await tryFillWithSelectors(callTool, identitySelectors, identityValue);
                if (!r) interactionFailed = true;
            }
            if (!interactionFailed && credentials.password && passwordSelectors.length > 0) {
                const r = await tryFillWithSelectors(
                    callTool,
                    passwordSelectors,
                    credentials.password,
                );
                if (!r) interactionFailed = true;
            }

            if (interactionFailed) {
                return {
                    shouldPause: true,
                    awaitUserMessage:
                        "Failed to fill login form fields. Please log in manually and continue.",
                };
            }

            if (submitSelectors.length > 0) {
                const clicked = await tryClickWithSelectors(callTool, submitSelectors);
                if (!clicked) {
                    const fallback = await callTool("pressKey", { key: "Enter" });
                    if (!fallback.success) {
                        return {
                            shouldPause: true,
                            awaitUserMessage:
                                "Could not submit login form. Please submit manually and continue.",
                        };
                    }
                }
            } else {
                const r = await callTool("pressKey", { key: "Enter" });
                if (!r.success) {
                    return {
                        shouldPause: true,
                        awaitUserMessage:
                            "Could not submit login form. Please submit manually and continue.",
                    };
                }
            }

            const authResult = await verifyAuthAndSave(callTool, state.currentUrl);
            if (!authResult.verified) {
                return {
                    shouldPause: true,
                    awaitUserMessage:
                        "Login may have failed (still on login page). Please check and try again.",
                };
            }
            return {};
        }

        if (interruption.type === "otp") {
            if (!credentials.code) {
                return {
                    shouldPause: true,
                    awaitUserMessage:
                        "Verification code required. Please provide the code to continue.",
                };
            }
            const codeSelectors = interruption.fieldSelectors?.code || [];
            const submitSelectors = interruption.fieldSelectors?.submit || [];

            if (codeSelectors.length > 0) {
                const filled = await tryFillWithSelectors(
                    callTool,
                    codeSelectors,
                    credentials.code,
                );
                if (!filled) {
                    return {
                        shouldPause: true,
                        awaitUserMessage:
                            "Failed to fill verification code. Please enter it manually and continue.",
                    };
                }
            }
            if (submitSelectors.length > 0) {
                const clicked = await tryClickWithSelectors(callTool, submitSelectors);
                if (!clicked) {
                    await callTool("pressKey", { key: "Enter" });
                }
            } else {
                await callTool("pressKey", { key: "Enter" });
            }

            const authResult = await verifyAuthAndSave(callTool, state.currentUrl);
            if (!authResult.verified) {
                return {
                    shouldPause: true,
                    awaitUserMessage:
                        "OTP verification may have failed. Please check and try again.",
                };
            }
            return {};
        }

        return {
            shouldPause: true,
            awaitUserMessage: interruption.message,
        };
    };

export const createAwaitUserNode =
    ({ callTool }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        const message =
            state.awaitUserMessage ||
            state.interruption?.message ||
            "User input required to continue.";
        await callTool("awaitUser", { message });
        await callTool("respond", { message, needsInput: true });
        return {
            shouldPause: true,
            awaitUserMessage: message,
        };
    };

export const createCaptureAfterResolveNode =
    ({ callTool }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        const capture = await callTool("captureCurrentPage", {});
        const summary = capture.success
            ? (capture.data as { summary?: string } | undefined)?.summary || null
            : `[Capture failed: ${capture.message || "unknown error"}]`;
        const url = capture.success
            ? (capture.data as { url?: string } | undefined)?.url || null
            : null;

        if (
            capture.success &&
            state.interruption &&
            AUTH_INTERRUPTION_TYPES.has(state.interruption.type)
        ) {
            await callTool("saveAuthState", {});
        }

        return {
            domSummary: summary,
            currentUrl: url,
        };
    };
