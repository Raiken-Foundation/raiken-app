import { BrowserSession } from "../../../browser/session";
import {
    describeAuthStateProblem,
    inspectAuthState,
    mapAuthCredentialsToFields,
    resolveAuthCredentials,
    resolveAuthStorageStateDestination,
} from "../../../config";
import { AgentMemory } from "../../memory";
import type { GraphStateType } from "../state";
import {
    extractPageTitle,
    getRequestedInputFields,
    getStructuralSignals,
    parseSummaryElements,
    shouldClassifyInterruption,
} from "../utils";
import { getCandidateAuthedRoutes, hasAuthSession, rememberAuthedEntry } from "./auth-entry";
import {
    buildFieldRequestMessage,
    classifyInterruption,
    findSubmitButtonSelectors,
    mapValuesToFields,
} from "./classify-interruption";
import type { AgentNodeDeps } from "./types";

const AUTH_INTERRUPTION_TYPES = new Set(["auth", "otp"]);

function canFillWithConfiguredCredentials(
    projectPath: string,
    requestedFields: NonNullable<GraphStateType["interruption"]>["requestedFields"],
): boolean {
    const fields = requestedFields ?? [];
    const configuredValues = mapAuthCredentialsToFields(
        fields,
        resolveAuthCredentials(projectPath),
    );
    return fields.length > 0 && fields.every((field) => configuredValues[field.key]);
}

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

/**
 * We hit a login page but a reusable session exists — try known protected
 * routes to slip past the login wall before asking the user to sign in. Returns
 * the recovered page (summary + URL) on success, or null if none worked.
 */
async function tryLoginWallRecovery(
    callTool: AgentNodeDeps["callTool"],
    projectPath: string,
): Promise<{ summary: string; url: string | null } | null> {
    const candidates = await getCandidateAuthedRoutes(projectPath);
    for (const candidate of candidates.slice(0, 3)) {
        const nav = await callTool("navigateTo", { url: candidate });
        if (!nav.success) continue;
        const data = nav.data as { summary?: string; url?: string } | undefined;
        const summary = data?.summary || null;
        if (!summary) continue;
        // Recovered only when no credential blocker remains on the landed page.
        if (!stillCredentialBlocked(parseSummaryElements(summary))) {
            const landedUrl = data?.url || candidate;
            rememberAuthedEntry(projectPath, landedUrl);
            return { summary, url: landedUrl };
        }
    }
    return null;
}

export const createDetectInterruptionNode =
    ({ callTool, projectPath, model }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        let summary = state.domSummary;
        if (!summary) {
            // A failed navigate/capture leaves `summary` null on purpose. The
            // error text is not DOM, and storing it would satisfy the generate
            // gate's grounding check with a string containing no elements.
            if (state.targetUrl) {
                const nav = await callTool("navigateTo", { url: state.targetUrl });
                summary = nav.success
                    ? (nav.data as { summary?: string } | undefined)?.summary || null
                    : null;
            } else {
                const capture = await callTool("captureCurrentPage", {});
                summary = capture.success
                    ? (capture.data as { summary?: string } | undefined)?.summary || null
                    : null;
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
                const requestedFields = getRequestedInputFields(elements);
                const configuredValues = mapAuthCredentialsToFields(
                    requestedFields,
                    resolveAuthCredentials(projectPath),
                );
                interruption = await classifyInterruption(
                    pageTitle,
                    elements,
                    signals,
                    state.userPrompt,
                    state.conversationHistory,
                    model,
                    // When resuming a blocker, the user's message is their reply
                    // to our field request — accept a bare value for a single
                    // field instead of re-asking.
                    state.resumeBlocker === true,
                    configuredValues,
                );
            }

            // Persist the login page NOW, while its form is actually on screen.
            // Once we sign in, the agent navigates away (and saveAuthState makes
            // future runs start already-authenticated), so this is the only
            // reliable moment to capture the real login URL + fields. Test
            // generation reads this back so auth specs use the observed route
            // instead of guessing "/login".
            if (interruption && AUTH_INTERRUPTION_TYPES.has(interruption.type)) {
                try {
                    let loginUrl: string | null = null;
                    try {
                        loginUrl = BrowserSession.getInstance(projectPath).getCurrentUrl();
                    } catch {
                        /* session not active */
                    }
                    if (!loginUrl || loginUrl === "about:blank") {
                        loginUrl = summary.match(/\[LIVE DOM CONTEXT - ([^\]]+)\]/)?.[1] || null;
                    }
                    const fields = (interruption.requestedFields || []).map((f) => ({
                        label: f.label,
                        type: f.type ?? null,
                        selector: f.selectors?.[0] ?? null,
                    }));
                    AgentMemory.getInstance(projectPath).setPreference(
                        "auth_login",
                        JSON.stringify({
                            url: loginUrl,
                            fields,
                            submit: interruption.submitSelectors?.[0] ?? null,
                            at: Date.now(),
                        }),
                    );
                    try {
                        const { recordLoginFlowFromEvidence } = await import(
                            "../../../cover/flow-store"
                        );
                        recordLoginFlowFromEvidence(projectPath);
                    } catch {
                        /* flow table may not be migrated yet */
                    }
                } catch {
                    /* memory not available — non-critical */
                }
            }

            // If the user's goal is to test the unauthenticated / login page
            // itself, the login wall is the TARGET — not a blocker. Drop the
            // interruption so we keep this DOM and generate a test for it,
            // rather than trying to sign in or recover past it below. (The
            // login URL/fields were still persisted just above.)
            if (
                interruption &&
                AUTH_INTERRUPTION_TYPES.has(interruption.type) &&
                state.authPrecondition === "unauthenticated"
            ) {
                interruption = null;
            }
        }

        // Login-wall recovery: we detected a login page BUT a reusable session
        // exists. That usually means we entered at the origin root (a login/
        // landing wall) instead of a protected route. Try known content routes to
        // slip past it before asking the user to log in. Skipped while the user is
        // actively supplying credentials (resumeBlocker) — then a real login is
        // intended.
        if (
            interruption &&
            AUTH_INTERRUPTION_TYPES.has(interruption.type) &&
            !state.resumeBlocker &&
            state.authPrecondition === "authenticated" &&
            hasAuthSession(projectPath)
        ) {
            try {
                const recovered = await tryLoginWallRecovery(callTool, projectPath);
                if (recovered) {
                    return {
                        domSummary: recovered.summary,
                        currentUrl: recovered.url,
                        interruption: null,
                        resumeBlocker: false,
                    };
                }
            } catch {
                /* recovery is best-effort — fall through to the stale-session hint */
            }

            if (!canFillWithConfiguredCredentials(projectPath, interruption.requestedFields)) {
                // The snapshot is structurally valid but the server rejected it.
                // Without configured credentials, refresh via the explicit auth
                // flow instead of guessing values or repeatedly probing routes.
                const staleMsg =
                    "Your saved login session looks expired — every protected route is redirecting to the " +
                    "login page. Refresh it by running `raiken auth` to capture a fresh session, then try again. " +
                    "Or reply with the credentials here and I'll sign in now.";
                return {
                    domSummary: summary,
                    interruption: { ...interruption, requiresUser: true, message: staleMsg },
                    awaitUserMessage: staleMsg,
                    resumeBlocker: false,
                };
            }
        }

        if (
            interruption &&
            AUTH_INTERRUPTION_TYPES.has(interruption.type) &&
            !state.resumeBlocker &&
            state.authPrecondition === "authenticated" &&
            !hasAuthSession(projectPath)
        ) {
            if (!canFillWithConfiguredCredentials(projectPath, interruption.requestedFields)) {
                const destination = resolveAuthStorageStateDestination(projectPath);
                const problem =
                    describeAuthStateProblem(inspectAuthState(destination)) ??
                    "Saved auth state is not usable. Run `raiken auth` to refresh it.";
                return {
                    domSummary: summary,
                    interruption: { ...interruption, requiresUser: true, message: problem },
                    awaitUserMessage: problem,
                    resumeBlocker: false,
                };
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

        // Remember a good authenticated entry route when the page is clean, so the
        // next run enters there directly instead of bouncing off the login wall.
        if (!interruption && state.authPrecondition === "authenticated") {
            try {
                let curUrl: string | null = state.currentUrl ?? null;
                if (!curUrl) {
                    curUrl = BrowserSession.getInstance(projectPath).getCurrentUrl();
                }
                rememberAuthedEntry(projectPath, curUrl);
            } catch {
                /* session/memory unavailable — non-critical */
            }
        }

        return {
            domSummary: summary,
            interruption,
            // Consume the blocker-resume flag: it only governs how THIS detection
            // interprets the user's reply (bare value vs new prompt). Leaving it
            // set would keep re-triggering reply-mode on later turns.
            resumeBlocker: false,
        };
    };

/**
 * Capture the current page and parse its interactive elements. Used by the
 * multi-step auth loop to re-inspect the page after each submit (a fresh
 * capture is required because the DOM changes between steps).
 */
async function captureElements(callTool: AgentNodeDeps["callTool"]): Promise<{
    url: string | null;
    elements: ReturnType<typeof parseSummaryElements>;
}> {
    const capture = await callTool("captureCurrentPage", {});
    if (!capture.success) return { url: null, elements: [] };
    const data = capture.data as { url?: string; summary?: string } | undefined;
    const url = data?.url || null;
    const elements = data?.summary ? parseSummaryElements(data.summary) : [];
    return { url, elements };
}

/**
 * True when the page still presents a credential-style blocker: a password or
 * verification-code field, a small dead-end form, or a blocking overlay.
 * Deliberately excludes the generic "has any input" signal so a logged-in page
 * that merely has a search box isn't mistaken for a login step still pending.
 */
function stillCredentialBlocked(elements: ReturnType<typeof parseSummaryElements>): boolean {
    const signals = getStructuralSignals(elements, "");
    return (
        signals.hasPasswordField ||
        signals.hasCodeField ||
        signals.isDeadEnd ||
        signals.hasBlockingOverlay
    );
}

export const createResolveInterruptionNode =
    ({ callTool, model, projectPath, signal }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        const interruption = state.interruption;
        if (!interruption) return {};

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

        // Generic auth/otp resolution: fill whatever fields the page is asking
        // for with whatever the user provided, regardless of field names.
        //
        // Runs as a bounded loop so identifier-first flows (email → Next →
        // password) complete: each iteration re-captures the page, fills the
        // fields THIS step presents, submits, then re-inspects. We only declare
        // success once no credential blocker remains — never on a bare URL
        // change, which used to fire while the password step was still showing.
        if (interruption.type === "auth" || interruption.type === "otp") {
            const MAX_STEPS = 4;
            const STEP_SETTLE_MS = 1800;
            let prevSignature = "";

            for (let step = 0; step < MAX_STEPS; step++) {
                if (signal?.aborted) break;
                const { url, elements } = await captureElements(callTool);

                // Past the blocker: no password/code/dead-end form left → done.
                if (!stillCredentialBlocked(elements)) {
                    await callTool("saveAuthState", {});
                    return {};
                }

                // On the first pass, prefer the fields/submit the detector
                // already resolved; on later steps re-derive from the fresh DOM.
                const requestedFields =
                    step === 0 && interruption.requestedFields?.length
                        ? interruption.requestedFields
                        : getRequestedInputFields(elements);
                const submitSelectors =
                    step === 0 && interruption.submitSelectors?.length
                        ? interruption.submitSelectors
                        : findSubmitButtonSelectors(elements);

                // Blocked but nothing fillable (captcha, passkey, …) → user acts.
                if (requestedFields.length === 0) {
                    return {
                        shouldPause: true,
                        awaitUserMessage:
                            interruption.message ||
                            "This page is blocked and I can't resolve it automatically. Please complete it manually and continue.",
                    };
                }

                const mapped = await mapValuesToFields(
                    requestedFields,
                    state.userPrompt,
                    state.conversationHistory,
                    model,
                    // resolveInterruption only runs after the user has provided
                    // input, so a bare single value is a valid one-field reply.
                    {
                        isReply: true,
                        presetValues: mapAuthCredentialsToFields(
                            requestedFields,
                            resolveAuthCredentials(projectPath),
                        ),
                    },
                );
                const fillable = requestedFields.filter((f) => mapped.values[f.key]);
                const unmet = requestedFields.filter((f) => !mapped.values[f.key]);

                // No-progress guard: the same form/URL after a submit means our
                // fill/submit didn't advance the flow — stop instead of looping.
                const signature = `${requestedFields
                    .map((f) => `${f.label}|${f.type || ""}`)
                    .join(",")}@${url || ""}`;
                if (signature === prevSignature) {
                    return {
                        shouldPause: true,
                        awaitUserMessage:
                            unmet.length > 0
                                ? buildFieldRequestMessage(unmet)
                                : "The page still looks blocked (the form is still showing). Please check and try again.",
                    };
                }

                // Can't fill anything this step is asking for → ask the user.
                if (fillable.length === 0) {
                    return {
                        shouldPause: true,
                        awaitUserMessage: buildFieldRequestMessage(requestedFields),
                    };
                }

                prevSignature = signature;

                let interactionFailed = false;
                for (const field of fillable) {
                    const value = mapped.values[field.key];
                    if (!value) continue;
                    const filled = await tryFillWithSelectors(callTool, field.selectors, value);
                    if (!filled) {
                        interactionFailed = true;
                        break;
                    }
                }
                if (interactionFailed) {
                    return {
                        shouldPause: true,
                        awaitUserMessage:
                            "Failed to fill the form fields. Please complete it manually and continue.",
                    };
                }

                if (submitSelectors.length > 0) {
                    const clicked = await tryClickWithSelectors(callTool, submitSelectors);
                    if (!clicked) await callTool("pressKey", { key: "Enter" });
                } else {
                    await callTool("pressKey", { key: "Enter" });
                }

                // Let the next step render before re-capturing (abort-aware).
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, STEP_SETTLE_MS);
                    signal?.addEventListener(
                        "abort",
                        () => {
                            clearTimeout(timer);
                            resolve();
                        },
                        { once: true },
                    );
                });
                if (signal?.aborted) break;
            }

            // Re-check once more after the final submit before giving up.
            const final = await captureElements(callTool);
            if (!stillCredentialBlocked(final.elements)) {
                await callTool("saveAuthState", {});
                return {};
            }
            return {
                shouldPause: true,
                awaitUserMessage:
                    "Sign-in has more steps than I could complete automatically. Please finish it manually and continue.",
            };
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
        // Only signal the pause via `awaitUser`. The runner already streams
        // `awaitUserMessage` (returned below) to the chat, so calling
        // `respond` here too would surface the identical message twice.
        await callTool("awaitUser", { message });
        return {
            shouldPause: true,
            awaitUserMessage: message,
        };
    };

export const createCaptureAfterResolveNode =
    ({ callTool }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        const capture = await callTool("captureCurrentPage", {});
        // Never surface the capture error as DOM — downstream grounding checks
        // treat any non-empty `domSummary` as a real page snapshot.
        const summary = capture.success
            ? (capture.data as { summary?: string } | undefined)?.summary || null
            : null;
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

        // The interruption has been resolved — clear it so the post-explore
        // edge doesn't re-route back into resolveInterruption on the stale
        // object (which would loop resolve→capture→explore until the recursion
        // limit). If explore later finds a NEW blocker it sets its own value.
        return {
            domSummary: summary,
            currentUrl: url,
            interruption: null,
        };
    };
