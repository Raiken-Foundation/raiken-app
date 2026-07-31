import type { AutonomyConfig } from "../../config";
import type { AuthPrecondition } from "../graph/utils";
import type { HITLAction } from "../hitl-types";

export type { HITLAction };

export type DestructiveAgentAction = "clearDiscoveryData";

/**
 * Autonomy settings for tool execution. Alias of the fully-resolved
 * `raiken.config.json` `autonomy` section (see `config/schema.ts`) so tool
 * gates and the repair/run nodes all reason about the exact same shape —
 * previously this was a separate, hand-duplicated interface that could
 * drift from the schema (e.g. it never picked up `maxRetries`).
 */
export type AutonomySettings = Required<AutonomyConfig>;

/**
 * Tool result that may require HITL confirmation
 */
export interface ToolResult<T = unknown> {
    success: boolean;
    data?: T;
    message: string;
    hitlRequired?: boolean;
    hitlAction?: HITLAction;
}

/**
 * Context passed to tool factory functions
 */
export interface ToolContext {
    projectPath: string;
    /** Autonomy settings for HITL decisions */
    autonomy?: AutonomySettings;
    /** Abort signal for cooperative cancellation of long-running tools */
    signal?: AbortSignal;
    /** The orchestrator already owns the project-operation lease for this tool run. */
    operationHeld?: boolean;
    /** Defense-in-depth authorization derived from the current user prompt. */
    isActionAuthorized?: (action: DestructiveAgentAction) => boolean;
    /** Current goal-level auth contract; read lazily after goal classification. */
    getAuthPrecondition?: () => AuthPrecondition;
}

/** Resolved dependencies shared by all tool groups for a project-scoped session. */
export interface AgentToolGroupDeps {
    projectPath: string;
    autonomy: AutonomySettings;
    signal?: AbortSignal;
    operationHeld: boolean;
    isActionAuthorized: (action: DestructiveAgentAction) => boolean;
    getAuthPrecondition: () => AuthPrecondition;
}

/** Result shape returned by interaction tools, including the post-action page. */
export interface ActionResultData {
    url?: string;
    summary?: string;
    changed?: boolean;
    /** False when the post-action page snapshot could not be captured. */
    captured?: boolean;
    clicked?: boolean;
    filled?: boolean;
    pressed?: boolean;
    selected?: boolean;
    toggled?: boolean;
}

export interface PageSnapshot {
    url: string;
    title: string;
    elements: number;
    forms: number;
    summary: string;
}
