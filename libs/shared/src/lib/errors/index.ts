/** Browser-safe error helpers — no `@raiken/core` runtime imports. */
export { formatTrpcClientErrorMessage, parseTrpcClientErrorData } from "./client";
export type {
    ClientSafeRaikenError,
    RaikenErrorCategory,
    RaikenErrorCode,
    RaikenTrpcErrorData,
} from "./types";
