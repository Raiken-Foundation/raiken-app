/**
 * Agent Tools - AI SDK Tool Definitions
 *
 * These tools are available to the LLM during reasoning.
 * The LLM decides when to call each tool based on the user's request.
 *
 * Internal implementation is decomposed under `./tools/` by capability group;
 * this module is the stable public facade.
 */

import { defaultConfig } from "../config";
import {
    AGENT_TOOL_REGISTRY_ORDER,
    createBrowserNavigationInteractionTools,
    createDiscoveryKnowledgeTools,
    createFilesystemTestArtifactTools,
    createMemoryTerminalControlTools,
    createTestExecutionRepairTools,
} from "./tools/registry";
import type { AgentToolGroupDeps, AutonomySettings, ToolContext } from "./tools/types";

export type { HITLAction } from "./hitl-types";
export type { WriteTestFileResult } from "./tools/filesystem-test-artifact";
export { writeTestFile } from "./tools/filesystem-test-artifact";
export {
    ensureBrowserStarted,
    resolveBrowserAuthStatePath,
} from "./tools/shared/browser-session";
export { redactToolArgs } from "./tools/shared/redaction";
export { closeSiteDbCache } from "./tools/shared/site-db-cache";
export type { ExecuteTestRunResult } from "./tools/test-execution-repair";
export {
    executeTestRun,
    VERIFICATION_REPEAT_EACH,
} from "./tools/test-execution-repair";
export type { AutonomySettings, ToolContext, ToolResult } from "./tools/types";

const defaultAutonomy: AutonomySettings = defaultConfig.autonomy;

/**
 * Create the agent tools with project context.
 * Tool names, schemas, and registry order are stable across releases.
 */
export function createAgentTools(ctx: ToolContext) {
    const {
        projectPath,
        autonomy = defaultAutonomy,
        signal,
        operationHeld = false,
        isActionAuthorized = () => false,
        getAuthPrecondition = () => "authenticated" as const,
    } = ctx;

    const deps: AgentToolGroupDeps = {
        projectPath,
        autonomy,
        signal,
        operationHeld,
        isActionAuthorized,
        getAuthPrecondition,
    };

    const filesystem = createFilesystemTestArtifactTools(deps);
    const discovery = createDiscoveryKnowledgeTools(deps);
    const testExecution = createTestExecutionRepairTools(deps);
    const memory = createMemoryTerminalControlTools(deps);
    const browser = createBrowserNavigationInteractionTools(deps);

    const composed = {
        searchCodebase: filesystem.searchCodebase,
        readFile: filesystem.readFile,
        listDirectory: filesystem.listDirectory,
        captureDOM: discovery.captureDOM,
        saveFile: filesystem.saveFile,
        runTest: testExecution.runTest,
        getMemoryContext: memory.getMemoryContext,
        getProjectOverview: filesystem.getProjectOverview,
        getDiscoveryOverview: discovery.getDiscoveryOverview,
        listDiscoveredPages: discovery.listDiscoveredPages,
        getDiscoveredPageSnapshot: discovery.getDiscoveredPageSnapshot,
        clearDiscoveryData: discovery.clearDiscoveryData,
        startDiscovery: discovery.startDiscovery,
        startBrowser: browser.startBrowser,
        closeBrowser: browser.closeBrowser,
        navigateTo: browser.navigateTo,
        clickElement: browser.clickElement,
        fillInput: browser.fillInput,
        pressKey: browser.pressKey,
        captureCurrentPage: browser.captureCurrentPage,
        waitForElement: browser.waitForElement,
        typeText: browser.typeText,
        hoverElement: browser.hoverElement,
        selectOption: browser.selectOption,
        toggleCheckbox: browser.toggleCheckbox,
        getCurrentUrl: browser.getCurrentUrl,
        saveAuthState: browser.saveAuthState,
        discoverLinks: browser.discoverLinks,
        done: memory.done,
        respond: memory.respond,
        awaitUser: memory.awaitUser,
    } satisfies Record<(typeof AGENT_TOOL_REGISTRY_ORDER)[number], unknown>;

    if (process.env["NODE_ENV"] !== "production") {
        const names = Object.keys(composed);
        for (let i = 0; i < AGENT_TOOL_REGISTRY_ORDER.length; i++) {
            if (names[i] !== AGENT_TOOL_REGISTRY_ORDER[i]) {
                throw new Error(
                    `Agent tool registry order mismatch at index ${i}: expected ${AGENT_TOOL_REGISTRY_ORDER[i]}, got ${names[i] ?? "(missing)"}`,
                );
            }
        }
    }

    return composed;
}

export type AgentTools = ReturnType<typeof createAgentTools>;
