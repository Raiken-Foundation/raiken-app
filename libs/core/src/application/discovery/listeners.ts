import type { SiteDiscovery } from "../../site-discovery/crawler";
import type { DiscoveryEvent, DiscoveryStats } from "../../site-discovery/types";
import { getDiscoveryState, patchDiscoveryState, pushDiscoveryEvent } from "./state";
import type { BackgroundDiscoverState, DiscoveryUxCallbacks } from "./types";

export function attachBackgroundStateListeners(
    discovery: SiteDiscovery,
    state: Exclude<BackgroundDiscoverState, { status: "idle" }>,
    ux?: DiscoveryUxCallbacks,
): void {
    const updateFromStats = () => {
        try {
            const stats = discovery.getStats();
            state.pages = stats.pagesDiscovered;
            state.links = stats.linksFound;
            state.currentUrl = stats.currentUrl || state.currentUrl;
        } catch {
            /* ignore */
        }
    };

    discovery.on("page_discovered", () => {
        updateFromStats();
        ux?.onPageDiscovered?.({
            type: "page_discovered",
            timestamp: Date.now(),
            data: { page: { url: state.currentUrl } },
        } as DiscoveryEvent);
    });
    discovery.on("auth_blocked", (event: DiscoveryEvent) => {
        state.status = "paused";
        ux?.onAuthBlocked?.(event);
    });
    discovery.on("blocker_detected", (event: DiscoveryEvent) => {
        const blocker = (event.data as { blocker?: { category?: string; severity?: string } })
            ?.blocker;
        if (blocker?.category === "auth_required") return;
        if (blocker?.severity && blocker.severity !== "pause") return;
        state.status = "paused";
        ux?.onBlockerDetected?.(event);
    });
    discovery.on("session_paused", (event: DiscoveryEvent) => {
        if (state.status !== "paused") {
            updateFromStats();
            state.status = "paused";
        }
        ux?.onSessionPaused?.(event);
    });
    discovery.on("session_completed", () => {
        updateFromStats();
        state.status = "completed";
        ux?.onSessionCompleted?.(discovery.getStats());
    });
    discovery.on("error", (event: DiscoveryEvent) => {
        state.status = "failed";
        state.error = (event.data as { error?: Error })?.error?.message ?? "unknown error";
        ux?.onError?.(event);
    });
}

export function attachDiscoveryRuntimeListeners(
    projectPath: string,
    discovery: SiteDiscovery,
): void {
    discovery.on("page_discovered", (event: unknown) => {
        const payload = (event ?? {}) as {
            data?: { page?: { url?: string; depth?: number } };
        };
        const page = payload.data?.page;
        const state = getDiscoveryState(projectPath);
        // The crawler's own counter is authoritative: it increments once per
        // unique page per run and already covers this event. A parallel
        // `state + 1` counter drifted from it on refreshed pages.
        let pagesDiscovered = state.pagesDiscovered;
        try {
            pagesDiscovered = discovery.getStats().pagesDiscovered;
        } catch {
            /* keep the previous value */
        }
        patchDiscoveryState(projectPath, {
            // A page committing during pause-drain (or right at completion)
            // must not resurrect "running" — the pause/completion owns the
            // phase from here on and hydration trusts it.
            phase:
                state.phase === "paused" || state.phase === "completed" || state.phase === "error"
                    ? state.phase
                    : "running",
            currentUrl: page?.url ?? state.currentUrl,
            currentDepth: typeof page?.depth === "number" ? page.depth : state.currentDepth,
            pagesDiscovered,
            requiresAuth: false,
        });
        pushDiscoveryEvent(projectPath, {
            type: "page_discovered",
            message: page?.url ? `Discovered ${page.url}` : "Discovered a page",
            data: { url: page?.url ?? null, depth: page?.depth ?? null },
        });
    });

    const handleBlockerEvent = (event: unknown) => {
        const payload = (event ?? {}) as {
            data?: {
                blocker?: {
                    url?: string;
                    blockerType?: string;
                    category?: string;
                    severity?: string;
                };
            };
        };
        const blocker = payload.data?.blocker;
        const category = (blocker?.category ?? "auth_required") as string;
        const severity = (blocker?.severity ?? "pause") as string;
        const isAuth = category === "auth_required";
        const state = getDiscoveryState(projectPath);
        if (severity !== "log") {
            patchDiscoveryState(projectPath, {
                phase: "paused",
                blockedAtUrl: blocker?.url ?? state.currentUrl,
                requiresAuth: isAuth,
                authBlockersFound: state.authBlockersFound + 1,
                currentUrl: blocker?.url ?? state.currentUrl,
            });
        } else {
            patchDiscoveryState(projectPath, {
                authBlockersFound: state.authBlockersFound + 1,
            });
        }
        const verb = isAuth ? "Authentication required" : `Blocker (${category})`;
        pushDiscoveryEvent(projectPath, {
            type: "auth_blocked",
            message: blocker?.url ? `${verb} at ${blocker.url}` : verb,
            data: {
                url: blocker?.url ?? null,
                category,
                severity,
                blockerType: blocker?.blockerType ?? null,
            },
        });
    };
    discovery.on("blocker_detected", handleBlockerEvent);

    discovery.on("session_paused", (event: unknown) => {
        const payload = (event ?? {}) as { data?: { reason?: "wall_clock_cap" } };
        const state = getDiscoveryState(projectPath);
        patchDiscoveryState(projectPath, {
            phase: "paused",
            blockedAtUrl: state.currentUrl ?? state.blockedAtUrl,
        });
        if (payload.data?.reason === "wall_clock_cap") {
            pushDiscoveryEvent(projectPath, {
                type: "warning",
                message: "Discovery paused: reached its time limit. Resume to continue crawling.",
            });
        }
    });

    discovery.on("session_resumed", () => {
        patchDiscoveryState(projectPath, {
            phase: "running",
            requiresAuth: false,
            lastError: null,
        });
        pushDiscoveryEvent(projectPath, {
            type: "continued",
            message: "Discovery resumed",
        });
    });

    discovery.on("session_completed", (event: unknown) => {
        const payload = (event ?? {}) as {
            data?: {
                reason?: "aborted";
                stats?: {
                    pagesDiscovered?: number;
                    linksFound?: number;
                    currentUrl?: string | null;
                    currentDepth?: number;
                };
            };
        };
        const stats = payload.data?.stats;
        const prevState = getDiscoveryState(projectPath);
        const finalPages =
            typeof stats?.pagesDiscovered === "number"
                ? stats.pagesDiscovered
                : prevState.pagesDiscovered;

        let completionReason: string | null = null;
        if (payload.data?.reason === "aborted") {
            completionReason = "Stopped by user";
        } else if (prevState.maxPages && finalPages >= prevState.maxPages) {
            completionReason = `Reached page limit (${prevState.maxPages})`;
        } else if (
            prevState.maxDepth &&
            typeof stats?.currentDepth === "number" &&
            stats.currentDepth >= prevState.maxDepth
        ) {
            completionReason = `Reached depth limit (${prevState.maxDepth})`;
        } else {
            completionReason = "All reachable pages crawled";
        }

        patchDiscoveryState(projectPath, {
            phase: "completed",
            currentUrl: stats?.currentUrl ?? null,
            currentDepth: typeof stats?.currentDepth === "number" ? stats.currentDepth : 0,
            pagesDiscovered: finalPages,
            linksFound:
                typeof stats?.linksFound === "number" ? stats.linksFound : prevState.linksFound,
            requiresAuth: false,
            blockedAtUrl: null,
            completionReason,
        });
        pushDiscoveryEvent(projectPath, {
            type: "session_completed",
            message: `Discovery completed: ${completionReason}`,
        });
    });

    discovery.on("error", (event: unknown) => {
        const payload = (event ?? {}) as { data?: { error?: Error } };
        const message = payload.data?.error?.message ?? "Discovery failed";
        patchDiscoveryState(projectPath, {
            phase: "error",
            lastError: message,
            requiresAuth: false,
        });
        pushDiscoveryEvent(projectPath, { type: "error", message });
    });

    discovery.on("snapshot_failed", (event: unknown) => {
        const payload = (event ?? {}) as { data?: { url?: string; message?: string } };
        const url = payload.data?.url ?? "(unknown url)";
        const reason = payload.data?.message ?? "unknown error";
        pushDiscoveryEvent(projectPath, {
            type: "warning",
            message: `Snapshot failed at ${url}: ${reason}`,
            data: { url, reason },
        });
    });

    discovery.on("warning", (event: unknown) => {
        const payload = (event ?? {}) as {
            data?: { url?: string; message?: string; status?: number | null };
        };
        const url = payload.data?.url ?? "(unknown url)";
        const message = payload.data?.message ?? "Warning";
        pushDiscoveryEvent(projectPath, {
            type: "warning",
            message: `${message} at ${url}`,
            data: payload.data ?? { url, message },
        });
    });
}

export function attachUxListeners(discovery: SiteDiscovery, ux?: DiscoveryUxCallbacks): void {
    if (!ux) return;
    if (ux.onPageDiscovered) discovery.on("page_discovered", ux.onPageDiscovered);
    if (ux.onAuthBlocked) discovery.on("auth_blocked", ux.onAuthBlocked);
    if (ux.onBlockerDetected) discovery.on("blocker_detected", ux.onBlockerDetected);
    if (ux.onSessionPaused) discovery.on("session_paused", ux.onSessionPaused);
    if (ux.onWarning) discovery.on("warning", ux.onWarning);
    if (ux.onError) discovery.on("error", ux.onError);
    if (ux.onSessionCompleted) {
        discovery.on("session_completed", (event: unknown) => {
            const payload = (event ?? {}) as {
                data?: { stats?: DiscoveryStats };
            };
            ux.onSessionCompleted?.(payload.data?.stats ?? null);
        });
    }
}
