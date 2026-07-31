import { canonicalProjectPath } from "../discovery-query-cache";
import type { BackgroundDiscoverState } from "./types";

/** Per-project discovery process state owned by the cross-project registry. */
export class DiscoveryProjectRuntime {
    readonly projectPath: string;

    background?: {
        state: Exclude<BackgroundDiscoverState, { status: "idle" }>;
        done: Promise<void>;
    };

    abortInFlight = false;
    autoResumeInFlight = false;
    private handoffAbort: AbortController | null = null;

    constructor(projectPath: string) {
        this.projectPath = canonicalProjectPath(projectPath);
    }

    get hasHandoffAbort(): boolean {
        return this.handoffAbort !== null;
    }

    setHandoffAbort(controller: AbortController): void {
        this.handoffAbort = controller;
    }

    getHandoffAbort(): AbortController | null {
        return this.handoffAbort;
    }

    clearHandoffAbort(): void {
        this.handoffAbort = null;
    }

    cancelHandoff(): boolean {
        if (!this.handoffAbort) return false;
        this.handoffAbort.abort();
        return true;
    }

    dispose(): void {
        this.background = undefined;
        if (this.handoffAbort) {
            this.handoffAbort.abort();
            this.handoffAbort = null;
        }
        this.abortInFlight = false;
        this.autoResumeInFlight = false;
    }
}
