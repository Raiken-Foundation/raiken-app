import type { RequestQueue } from "crawlee";
import type { DiscoveryOptions } from "../types";

export type StorageStateCookie = {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    url?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
};

export type StorageStateInput = {
    cookies?: StorageStateCookie[];
    origins?: Array<{
        origin: string;
        localStorage?: Array<{ name: string; value: string }>;
    }>;
};

export type PlaywrightStorageState = {
    cookies: StorageStateCookie[];
    origins: Array<{
        origin: string;
        localStorage: Array<{ name: string; value: string }>;
    }>;
};

export type PendingRequest = {
    url: string;
    uniqueKey: string;
    userData?: Record<string, unknown>;
};

export type QueuedRequestSeed = {
    url: string;
    uniqueKey?: string;
    userData?: Record<string, unknown>;
};

export type FailedRequestRecord = {
    url: string;
    reason: string;
    status: number | null;
};

export type CrawlerEventPayload = {
    type: string;
    data: unknown;
    timestamp: number;
};

export type RequiredDiscoveryOptions = Required<DiscoveryOptions>;

export type CrawlerRuntimeContext = {
    options: RequiredDiscoveryOptions;
    queueName: string;
    requestQueue: RequestQueue | null;
    pendingRequests: Map<string, PendingRequest>;
    queuedRequests: QueuedRequestSeed[] | null;
    playwrightStorageState: PlaywrightStorageState | null;
};
