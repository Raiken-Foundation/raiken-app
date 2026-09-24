import { useEffect, useRef, useState } from "react";
import { trpc } from "../../utils/trpc";
import { shouldAutoBuildGraph } from "./run-output-parser";

export function useCodeGraph() {
    const utils = trpc.useUtils();
    const [isBuilding, setIsBuilding] = useState(false);
    const [graphBuildError, setGraphBuildError] = useState<string | null>(null);
    const graphBuildAttemptedRef = useRef(false);

    const lastBumpRef = useRef<number | null>(null);
    const invalidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const { data: bumpData } = trpc.getFileChangeBump.useQuery(undefined, {
        refetchInterval: 1500,
        refetchIntervalInBackground: false,
    });

    useEffect(() => {
        const bump = bumpData?.bump;
        if (bump === undefined) return;
        if (lastBumpRef.current === null) {
            lastBumpRef.current = bump;
            return;
        }
        if (bump === lastBumpRef.current) return;
        lastBumpRef.current = bump;

        // While the graph is (re)building, the DB is half-written — every
        // indexer batch fires watcher bumps, and refetching against the
        // partial graph renders phantom file-tree entries and transient
        // empty spec lists that self-heal afterwards. Skip here; the
        // build's onSuccess performs the authoritative invalidation.
        if (isBuilding) return;

        // Coalesce burst bumps (one per watcher event) into a single
        // refetch once the burst settles.
        if (invalidateTimerRef.current) clearTimeout(invalidateTimerRef.current);
        invalidateTimerRef.current = setTimeout(() => {
            invalidateTimerRef.current = null;
            utils.getGraphFiles.invalidate();
            utils.listTestFiles.invalidate();
        }, 750);
    }, [bumpData?.bump, utils, isBuilding]);

    useEffect(
        () => () => {
            if (invalidateTimerRef.current) clearTimeout(invalidateTimerRef.current);
        },
        [],
    );

    const { data: projectInfo } = trpc.getProjectInfo.useQuery();
    const { data: statsData } = trpc.getGraphStats.useQuery({});

    const buildGraphMutation = trpc.buildCodeGraph.useMutation({
        onSuccess: async () => {
            // Covers any watcher bumps skipped while the build was running.
            await Promise.all([
                utils.getGraphStats.invalidate(),
                utils.getGraphFiles.invalidate(),
                utils.listTestFiles.invalidate(),
            ]);
            setIsBuilding(false);
            setGraphBuildError(null);
        },
        onError: (error) => {
            console.error("❌ Failed to build code graph:", error);
            setIsBuilding(false);
            setGraphBuildError(error.message);
        },
    });

    const { isLoading: filesLoading } = trpc.getGraphFiles.useQuery(
        { limit: 1000, offset: 0 },
        { enabled: (statsData?.totalFiles ?? 0) > 0 },
    );

    useEffect(() => {
        if (!shouldAutoBuildGraph(statsData, graphBuildAttemptedRef.current, isBuilding)) return;
        graphBuildAttemptedRef.current = true;
        setGraphBuildError(null);
        setIsBuilding(true);
        buildGraphMutation.mutate({ path: ".", persist: true });
    }, [statsData, isBuilding, buildGraphMutation.mutate]);

    const handleRetryGraphBuild = () => {
        if (isBuilding) return;
        graphBuildAttemptedRef.current = true;
        setGraphBuildError(null);
        setIsBuilding(true);
        buildGraphMutation.mutate({ path: ".", persist: true });
    };

    const isIndexing = filesLoading || isBuilding;

    return {
        projectInfo,
        isIndexing,
        isBuilding,
        graphBuildError,
        handleRetryGraphBuild,
    };
}
