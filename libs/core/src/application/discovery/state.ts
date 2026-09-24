import {
    type DiscoveryPhase,
    type DiscoveryRuntimeEvent,
    type DiscoveryRuntimeState,
    discoveryCoordinator,
} from "../../site-discovery/coordinator";

export { MAX_DISCOVERY_EVENTS } from "../../site-discovery/coordinator";

const discoveryJobStore = discoveryCoordinator.jobStore;
const handoffJobStore = discoveryCoordinator.handoffStore;

export { discoveryCoordinator, discoveryJobStore, handoffJobStore };

export function getDiscoveryState(projectPath: string): DiscoveryRuntimeState {
    return discoveryCoordinator.getState(projectPath);
}

export function patchDiscoveryState(
    projectPath: string,
    patch: Partial<DiscoveryRuntimeState>,
): DiscoveryRuntimeState {
    return discoveryCoordinator.patchState(projectPath, patch);
}

export function pushDiscoveryEvent(
    projectPath: string,
    event: Omit<DiscoveryRuntimeEvent, "id" | "timestamp">,
): void {
    discoveryCoordinator.pushEvent(projectPath, event);
}

export function toDiscoveryPhase(status: string | undefined): DiscoveryPhase {
    if (status === "running" || status === "paused" || status === "completed") {
        return status;
    }
    if (status === "failed") {
        return "error";
    }
    return "idle";
}

export function toIsoDate(value: unknown): string | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return new Date(value).toISOString();
    }
    if (typeof value === "string" && value.trim()) {
        const asNumber = Number(value);
        if (Number.isFinite(asNumber)) {
            return new Date(asNumber).toISOString();
        }
        const asDate = new Date(value);
        if (!Number.isNaN(asDate.getTime())) {
            return asDate.toISOString();
        }
    }
    return null;
}
