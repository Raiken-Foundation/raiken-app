/**
 * Browser-safe `@raiken/shared` entry.
 *
 * Dashboard and other Vite bundles must only import from this file (or the
 * explicit leaf modules re-exported here). Node servers should use
 * `@raiken/shared/server` instead.
 */

export {
    type AgentStreamErrorField,
    type AgentStreamSafeError,
    agentStreamErrorMessage,
    parseAgentStreamError,
    type SseAgentStreamEvent,
} from "./lib/agent-stream-events";
export {
    type AgentStreamEventPayload,
    decodeAgentMarkerJson,
    decodeHitlPayload,
    extractHitlMarker,
    type ParsedAgentActivity,
    parseAgentActivity,
    type SplitAgentStreamChunkResult,
    splitAgentStreamChunk,
} from "./lib/agent-stream-markers";
export { defaultConfig } from "./lib/config-defaults";
export { createSettingsConfigPatch, type SecretDrafts } from "./lib/config-patch";
export type {
    PublicRaikenConfig,
    RaikenConfig,
} from "./lib/config-public";
export { AI_PROVIDER_IDS, type AIProviderId } from "./lib/config-public";
export {
    type ClientSafeRaikenError,
    formatTrpcClientErrorMessage,
    parseTrpcClientErrorData,
    type RaikenErrorCategory,
    type RaikenErrorCode,
    type RaikenTrpcErrorData,
} from "./lib/errors";
export type { HealthChecks, HealthStatus } from "./lib/health-types";
export type { HitlWorkflowRecord, HitlWorkflowStatus } from "./lib/hitl-workflow";
export type { AppRouter } from "./lib/router/app-router-type";
export {
    findSharedSlashMetadata,
    SHARED_SLASH_COMMAND_METADATA,
    type SharedSlashCommandMetadata,
} from "./lib/slash-command-metadata";
export { splitTestSavePath, type TestSavePathParts } from "./lib/test-save-path";
export { getRaikenVersion } from "./lib/version";
