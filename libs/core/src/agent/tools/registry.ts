import {
    BROWSER_NAVIGATION_INTERACTION_TOOL_NAMES,
    createBrowserNavigationInteractionTools,
} from "./browser-navigation-interaction";
import {
    createDiscoveryKnowledgeTools,
    DISCOVERY_KNOWLEDGE_TOOL_NAMES,
} from "./discovery-knowledge";
import {
    createFilesystemTestArtifactTools,
    FILESYSTEM_TEST_ARTIFACT_TOOL_NAMES,
} from "./filesystem-test-artifact";
import {
    createMemoryTerminalControlTools,
    MEMORY_TERMINAL_CONTROL_TOOL_NAMES,
} from "./memory-terminal-control";
import {
    createTestExecutionRepairTools,
    TEST_EXECUTION_REPAIR_TOOL_NAMES,
} from "./test-execution-repair";

/**
 * Canonical registry order for the composed agent tool surface.
 * Interleaves groups to preserve the historical `createAgentTools` key order.
 */
export const AGENT_TOOL_REGISTRY_ORDER = [
    ...FILESYSTEM_TEST_ARTIFACT_TOOL_NAMES.slice(0, 3),
    DISCOVERY_KNOWLEDGE_TOOL_NAMES[0],
    FILESYSTEM_TEST_ARTIFACT_TOOL_NAMES[4],
    TEST_EXECUTION_REPAIR_TOOL_NAMES[0],
    MEMORY_TERMINAL_CONTROL_TOOL_NAMES[0],
    FILESYSTEM_TEST_ARTIFACT_TOOL_NAMES[3],
    ...DISCOVERY_KNOWLEDGE_TOOL_NAMES.slice(1),
    ...BROWSER_NAVIGATION_INTERACTION_TOOL_NAMES,
    ...MEMORY_TERMINAL_CONTROL_TOOL_NAMES.slice(1),
] as const;

export type AgentToolName = (typeof AGENT_TOOL_REGISTRY_ORDER)[number];

export const AGENT_TOOL_GROUP_REGISTRY = {
    filesystemTestArtifact: FILESYSTEM_TEST_ARTIFACT_TOOL_NAMES,
    testExecutionRepair: TEST_EXECUTION_REPAIR_TOOL_NAMES,
    discoveryKnowledge: DISCOVERY_KNOWLEDGE_TOOL_NAMES,
    browserNavigationInteraction: BROWSER_NAVIGATION_INTERACTION_TOOL_NAMES,
    memoryTerminalControl: MEMORY_TERMINAL_CONTROL_TOOL_NAMES,
} as const;

export {
    BROWSER_NAVIGATION_INTERACTION_TOOL_NAMES,
    DISCOVERY_KNOWLEDGE_TOOL_NAMES,
    FILESYSTEM_TEST_ARTIFACT_TOOL_NAMES,
    MEMORY_TERMINAL_CONTROL_TOOL_NAMES,
    TEST_EXECUTION_REPAIR_TOOL_NAMES,
    createBrowserNavigationInteractionTools,
    createDiscoveryKnowledgeTools,
    createFilesystemTestArtifactTools,
    createMemoryTerminalControlTools,
    createTestExecutionRepairTools,
};
