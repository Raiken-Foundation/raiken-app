/**
 * Server-only compile-time drift gate for browser-safe error transport types.
 * The dashboard keeps a mirrored leaf contract so it never imports core's
 * Node-only runtime graph.
 */
import type {
    RaikenErrorCategory as CoreRaikenErrorCategory,
    RaikenErrorCode as CoreRaikenErrorCode,
    SafeRaikenErrorPayload,
} from "@raiken/core";
import type { ClientSafeRaikenError, RaikenErrorCategory, RaikenErrorCode } from "./errors/types";
import type { AssertMutuallyExact, ExpectTrue } from "./type-parity";

export type RaikenErrorCategoryParity = AssertMutuallyExact<
    RaikenErrorCategory,
    CoreRaikenErrorCategory
>;
export type RaikenErrorCodeParity = AssertMutuallyExact<RaikenErrorCode, CoreRaikenErrorCode>;
export type RaikenErrorPayloadParity = AssertMutuallyExact<
    ClientSafeRaikenError,
    SafeRaikenErrorPayload
>;

export type ErrorParityVerified = ExpectTrue<
    RaikenErrorCategoryParity & RaikenErrorCodeParity & RaikenErrorPayloadParity
>;
