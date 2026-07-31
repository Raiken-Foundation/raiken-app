import { AsyncLocalStorage } from "node:async_hooks";
import * as crypto from "node:crypto";
import { safeProjectRef } from "./project-path";
import type { CorrelationContext } from "./types";

const storage = new AsyncLocalStorage<CorrelationContext>();

/** Generate a new correlation id. */
export function createCorrelationId(): string {
    return crypto.randomBytes(8).toString("hex");
}

function enrichPartial(partial: CorrelationContext & { projectPath?: string }): CorrelationContext {
    const enriched: CorrelationContext = { ...partial };
    if (partial.projectPath && !enriched.projectRef) {
        enriched.projectRef = safeProjectRef(partial.projectPath);
    }
    const { projectPath: _drop, ...store } = enriched as CorrelationContext & {
        projectPath?: string;
    };
    return store;
}

/** Read the active correlation context, if any. */
export function getCorrelationContext(): CorrelationContext | undefined {
    return storage.getStore();
}

/**
 * Merge partial context into the active AsyncLocalStorage store.
 *
 * - **Inside** `runWithCorrelationContext`: mutates the scoped store in place
 *   (safe for concurrent requests — each request owns its own store object).
 * - **Outside** a scope: returns a merged snapshot only; does **not** bind context.
 *   Callers must pass the snapshot to `runWithCorrelationContext` explicitly.
 */
export function mergeCorrelationContext(
    partial: CorrelationContext & { projectPath?: string },
): CorrelationContext {
    const patch = enrichPartial(partial);
    const current = storage.getStore();
    if (!current) {
        return patch;
    }
    Object.assign(current, patch);
    return { ...current };
}

/** Run `fn` with the given correlation context bound for its async subtree. */
export function runWithCorrelationContext<T>(
    context: CorrelationContext & { projectPath?: string },
    fn: () => T,
): T {
    const store = enrichPartial(context);
    return storage.run(store, fn);
}

/** Ensure a correlation id exists in the current scope; creates one if missing. */
export function ensureCorrelationId(): string {
    const current = storage.getStore();
    if (current?.correlationId) return current.correlationId;
    const correlationId = createCorrelationId();
    if (current) {
        current.correlationId = correlationId;
    }
    return correlationId;
}

/** Flatten correlation fields for structured events and error metadata. */
export function correlationFields(): CorrelationContext {
    const ctx = storage.getStore();
    if (!ctx) return {};
    const { projectPath: _ignored, ...rest } = ctx as CorrelationContext & { projectPath?: string };
    return rest;
}

/**
 * Merge active caller correlation (when present) with operation-specific ids.
 * Does not bind context — use with {@link beginOperationScope} or {@link runDetachedOperation}.
 */
export function buildOperationCorrelationContext(
    partial: CorrelationContext & { projectPath?: string },
): CorrelationContext {
    const caller = storage.getStore();
    return enrichPartial({ ...(caller ? { ...caller } : {}), ...partial });
}

/**
 * Establish a long-running operation scope that survives after the caller returns.
 * When `fn` returns a Promise or AsyncGenerator, Node ALS keeps context for its async subtree.
 */
export function beginOperationScope<T>(
    partial: CorrelationContext & { projectPath?: string },
    fn: () => T,
): T {
    const store = buildOperationCorrelationContext(partial);
    return storage.run(store, fn);
}

/** Detached async operation — merges caller correlation then runs `fn` in its own scope. */
export function runDetachedOperation<T>(
    partial: CorrelationContext & { projectPath?: string },
    fn: () => Promise<T>,
): Promise<T> {
    return beginOperationScope(partial, () => Promise.resolve(fn()));
}
