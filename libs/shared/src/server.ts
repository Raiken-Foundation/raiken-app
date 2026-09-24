/**
 * Node-only `@raiken/shared` entry — CLI backend, tRPC router host, tests.
 *
 * Dashboard and other browser bundles must import from `@raiken/shared`
 * (browser entry) instead, which excludes this module graph.
 */

export { clearSecretsInputSchema } from "./lib/config-contract";
import "./lib/config-parity.server";
import "./lib/error-parity.server";

export type {
    AIProviderIdParity,
    ConfigParityVerified,
    PublicRaikenConfigParity,
    UiRaikenDefaultsParity,
} from "./lib/config-parity.server";
export * from "./lib/config-server";
export type {
    ErrorParityVerified,
    RaikenErrorCategoryParity,
    RaikenErrorCodeParity,
    RaikenErrorPayloadParity,
} from "./lib/error-parity.server";
export {
    buildRaikenTrpcErrorData,
    raikenCategoryToTrpcCode,
    toTrpcError,
} from "./lib/errors/trpc-adapter";
export { type AppRouter, appRouter, type Context } from "./lib/router";
export { procedure, t } from "./lib/router/trpc";
export { getRaikenVersion } from "./lib/version.server";
