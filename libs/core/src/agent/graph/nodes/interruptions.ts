import type { GraphStateType } from "../state";
import { detectInterruption, extractCredentials, parseSummaryElements } from "../utils";
import type { AgentNodeDeps } from "./types";

export const createDetectInterruptionNode =
    ({ callTool }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        let summary = state.domSummary;
        if (!summary) {
            const capture = await callTool("captureCurrentPage", {});
            summary = (capture.data as { summary?: string } | undefined)?.summary || null;
        }
        const elements = summary ? parseSummaryElements(summary) : [];
        const credentials = extractCredentials(state.userPrompt, state.conversationHistory);
        const interruption = summary ? detectInterruption(summary, elements, credentials) : null;
        return {
            domSummary: summary,
            interruption,
        };
    };

export const createResolveInterruptionNode =
    ({ callTool }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        const interruption = state.interruption;
        if (!interruption) return {};
        const credentials = extractCredentials(state.userPrompt, state.conversationHistory);
        if (interruption.type === "consent" && interruption.actionSelector) {
            await callTool("clickElement", { selector: interruption.actionSelector });
            return {};
        }
        if (interruption.type === "auth") {
            const needsUsernameOrEmail = !credentials.username && !credentials.email && !credentials.useDefaults;
            const needsPassword =
                Boolean(interruption.fieldSelectors?.password) &&
                !credentials.password &&
                !credentials.useDefaults;
            if (needsUsernameOrEmail || needsPassword) {
                return {
                    shouldPause: true,
                    awaitUserMessage: "Authentication required. Please provide credentials to continue.",
                };
            }
            if (credentials.username && interruption.fieldSelectors?.username) {
                await callTool("fillInput", {
                    selector: interruption.fieldSelectors.username,
                    value: credentials.username,
                });
            }
            if (credentials.email && interruption.fieldSelectors?.email) {
                await callTool("fillInput", {
                    selector: interruption.fieldSelectors.email,
                    value: credentials.email,
                });
            }
            if (credentials.password && interruption.fieldSelectors?.password) {
                await callTool("fillInput", {
                    selector: interruption.fieldSelectors.password,
                    value: credentials.password,
                });
            }
            if (interruption.fieldSelectors?.submit) {
                await callTool("clickElement", { selector: interruption.fieldSelectors.submit });
            } else {
                await callTool("pressKey", { key: "Enter" });
            }
            return {};
        }
        if (interruption.type === "otp") {
            if (!credentials.code) {
                return {
                    shouldPause: true,
                    awaitUserMessage: "Verification code required. Please provide the code to continue.",
                };
            }
            if (interruption.fieldSelectors?.code) {
                await callTool("fillInput", {
                    selector: interruption.fieldSelectors.code,
                    value: credentials.code,
                });
            }
            if (interruption.fieldSelectors?.submit) {
                await callTool("clickElement", { selector: interruption.fieldSelectors.submit });
            } else {
                await callTool("pressKey", { key: "Enter" });
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
    async () => {
        const capture = await callTool("captureCurrentPage", {});
        const summary = (capture.data as { summary?: string } | undefined)?.summary || null;
        const url = (capture.data as { url?: string } | undefined)?.url || null;
        return {
            domSummary: summary,
            currentUrl: url,
        };
    };
