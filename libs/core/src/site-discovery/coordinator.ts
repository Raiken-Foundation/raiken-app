import type { SiteDiscovery } from "./crawler";

export type DiscoveryPhase = "idle" | "running" | "paused" | "completed" | "error";

export interface DiscoveryRuntimeEvent {
    id: string;
    timestamp: string;
    type:
        | "page_discovered"
        | "auth_blocked"
        | "session_completed"
        | "error"
        | "warning"
        | "started"
        | "continued"
        | "stopped"
        | "cleared";
    message: string;
    data?: Record<string, unknown>;
}

export interface DiscoveryRuntimeState {
    phase: DiscoveryPhase;
    startedAt: string | null;
    updatedAt: string;
    currentUrl: string | null;
    currentDepth: number;
    pagesDiscovered: number;
    linksFound: number;
    authBlockersFound: number;
    blockedAtUrl: string | null;
    requiresAuth: boolean;
    lastError: string | null;
    lastEvents: DiscoveryRuntimeEvent[];
    maxPages: number | null;
    maxDepth: number | null;
    completionReason: string | null;
}

export interface DiscoveryJob {
    discovery: SiteDiscovery;
    promise: Promise<void>;
}

export const MAX_DISCOVERY_EVENTS = 100;

export class DiscoveryCoordinator {
    private readonly states = new Map<string, DiscoveryRuntimeState>();
    private readonly jobs = new Map<string, DiscoveryJob>();
    private readonly handoffs = new Map<string, Promise<unknown>>();

    readonly jobStore = {
        has: (projectPath: string) => this.jobs.has(projectPath),
        get: (projectPath: string) => this.jobs.get(projectPath),
        set: (projectPath: string, job: DiscoveryJob) => {
            this.jobs.set(projectPath, job);
            return this.jobStore;
        },
        delete: (projectPath: string) => this.jobs.delete(projectPath),
    };

    readonly handoffStore = {
        has: (projectPath: string) => this.handoffs.has(projectPath),
        get: (projectPath: string) => this.handoffs.get(projectPath),
        set: (projectPath: string, handoff: Promise<unknown>) => {
            this.handoffs.set(projectPath, handoff);
            return this.handoffStore;
        },
        delete: (projectPath: string) => this.handoffs.delete(projectPath),
    };

    getState(projectPath: string): DiscoveryRuntimeState {
        const existing = this.states.get(projectPath);
        if (existing) return existing;
        const created: DiscoveryRuntimeState = {
            phase: "idle",
            startedAt: null,
            updatedAt: new Date().toISOString(),
            currentUrl: null,
            currentDepth: 0,
            pagesDiscovered: 0,
            linksFound: 0,
            authBlockersFound: 0,
            blockedAtUrl: null,
            requiresAuth: false,
            lastError: null,
            lastEvents: [],
            maxPages: null,
            maxDepth: null,
            completionReason: null,
        };
        this.states.set(projectPath, created);
        return created;
    }

    patchState(projectPath: string, patch: Partial<DiscoveryRuntimeState>): DiscoveryRuntimeState {
        const next = {
            ...this.getState(projectPath),
            ...patch,
            updatedAt: new Date().toISOString(),
        };
        this.states.set(projectPath, next);
        return next;
    }

    resetState(projectPath: string): DiscoveryRuntimeState {
        this.states.delete(projectPath);
        return this.getState(projectPath);
    }

    pushEvent(projectPath: string, event: Omit<DiscoveryRuntimeEvent, "id" | "timestamp">): void {
        const state = this.getState(projectPath);
        this.patchState(projectPath, {
            lastEvents: [
                ...state.lastEvents,
                {
                    ...event,
                    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    timestamp: new Date().toISOString(),
                },
            ].slice(-MAX_DISCOVERY_EVENTS),
        });
    }
}

export const discoveryCoordinator = new DiscoveryCoordinator();
