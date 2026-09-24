import { useEffect, useState } from "react";
import { trpc } from "../../utils/trpc";
import { DEFAULT_EXCLUDE, PAGES_PER_PAGE } from "./constants";
import {
    type RuntimePollQueryState,
    resolveDataRefetchInterval,
    resolveRuntimeRefetchInterval,
} from "./runtime-state";
import type { DiscoveryFormState } from "./types";

export function useDiscoveryRuntime(selectedPageUrl: string | null, pageOffset: number) {
    const runtimeQuery = trpc.getDiscoveryRuntime.useQuery(
        {},
        {
            refetchInterval: (query) =>
                resolveRuntimeRefetchInterval(
                    query.state.data as RuntimePollQueryState | undefined,
                ),
            refetchOnWindowFocus: false,
        },
    );

    const runtime = runtimeQuery.data;

    const statsQuery = trpc.getDiscoveryStats.useQuery(
        {},
        {
            refetchInterval: () => resolveDataRefetchInterval(runtime?.phase),
            refetchOnWindowFocus: false,
        },
    );
    const sessionQuery = trpc.getDiscoverySession.useQuery(
        {},
        {
            refetchInterval: () => resolveDataRefetchInterval(runtime?.phase),
            refetchOnWindowFocus: false,
        },
    );
    const pagesQuery = trpc.getDiscoveredPages.useQuery(
        { limit: PAGES_PER_PAGE, offset: pageOffset },
        {
            refetchInterval: () => resolveDataRefetchInterval(runtime?.phase),
            refetchOnWindowFocus: false,
        },
    );
    const pageSnapshotQuery = trpc.getDiscoveredPageSnapshot.useQuery(
        { url: selectedPageUrl ?? "" },
        { enabled: Boolean(selectedPageUrl), refetchOnWindowFocus: false },
    );
    const blockersQuery = trpc.getAuthBlockers.useQuery(
        {},
        {
            refetchInterval: () => resolveDataRefetchInterval(runtime?.phase),
            refetchOnWindowFocus: false,
        },
    );
    const timelineQuery = trpc.getDiscoveryTimeline.useQuery(
        { limit: 50 },
        {
            refetchInterval: () => resolveDataRefetchInterval(runtime?.phase),
            refetchOnWindowFocus: false,
        },
    );
    const linksQuery = trpc.getVerifiedLinks.useQuery(
        {},
        {
            refetchInterval: () => resolveDataRefetchInterval(runtime?.phase),
            refetchOnWindowFocus: false,
        },
    );
    const authAssistQuery = trpc.authAssist.useQuery(
        {},
        { enabled: false, refetchOnWindowFocus: false },
    );
    const discoveryDefaultsQuery = trpc.getDiscoveryDefaults.useQuery(
        {},
        { refetchOnWindowFocus: false, staleTime: Infinity },
    );

    useEffect(() => {
        if (runtime?.requiresAuth) void authAssistQuery.refetch();
    }, [runtime?.requiresAuth]);

    return {
        runtimeQuery,
        statsQuery,
        sessionQuery,
        pagesQuery,
        pageSnapshotQuery,
        blockersQuery,
        timelineQuery,
        linksQuery,
        authAssistQuery,
        discoveryDefaultsQuery,
        runtime,
        stats: statsQuery.data,
        latestSession: sessionQuery.data,
        pages: pagesQuery.data?.pages ?? [],
        pagesTotal: pagesQuery.data?.total ?? 0,
        pagesHasMore: pagesQuery.data?.hasMore ?? false,
        blockers: blockersQuery.data?.blockers ?? [],
        timeline: timelineQuery.data?.events ?? [],
        selectedSnapshot: pageSnapshotQuery.data,
        verifiedLinks: linksQuery.data?.verifiedLinks ?? [],
        brokenLinks: linksQuery.data?.brokenLinks ?? [],
        verifiedCount: linksQuery.data?.verifiedCount ?? 0,
        brokenCount: linksQuery.data?.brokenCount ?? 0,
        detectedBaseURL: discoveryDefaultsQuery.data?.baseURL ?? null,
    };
}

export function useDiscoveryForm(detectedBaseURL: string | null) {
    const [form, setForm] = useState<DiscoveryFormState>({
        url: "",
        maxPages: "100",
        maxDepth: "5",
        timeout: "30000",
        skipAuth: false,
        excludePatterns: [...DEFAULT_EXCLUDE],
    });

    useEffect(() => {
        if (!detectedBaseURL) return;
        setForm((prev) => (prev.url === "" ? { ...prev, url: detectedBaseURL } : prev));
    }, [detectedBaseURL]);

    const addExcludePattern = (value: string) => {
        const trimmed = value.trim();
        if (!trimmed || form.excludePatterns.includes(trimmed)) return;
        setForm((prev) => ({ ...prev, excludePatterns: [...prev.excludePatterns, trimmed] }));
    };

    const removeExcludePattern = (pattern: string) => {
        setForm((prev) => ({
            ...prev,
            excludePatterns: prev.excludePatterns.filter((p) => p !== pattern),
        }));
    };

    const handleExcludeKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
            e.preventDefault();
            const input = e.currentTarget;
            addExcludePattern(input.value);
            input.value = "";
        }
    };

    return {
        form,
        setForm,
        addExcludePattern,
        removeExcludePattern,
        handleExcludeKeyDown,
    };
}
