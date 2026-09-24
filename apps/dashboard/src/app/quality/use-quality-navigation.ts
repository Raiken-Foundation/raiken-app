import { useCallback, useEffect, useMemo, useState } from "react";
import { trpc } from "../../utils/trpc";
import { getToolFromHash } from "./helpers";
import type { ToolId } from "./types";

export function useQualityNavigation() {
    const projectQuery = trpc.getProjectInfo.useQuery();
    const projectName = useMemo(() => {
        const p = projectQuery.data?.path;
        if (!p) return "—";
        const parts = p.split("/").filter(Boolean);
        return parts[parts.length - 1] || p;
    }, [projectQuery.data]);

    const [active, setActive] = useState<ToolId>(() =>
        typeof window === "undefined" ? "doctor" : getToolFromHash(),
    );

    useEffect(() => {
        const onHash = () => setActive(getToolFromHash());
        window.addEventListener("hashchange", onHash);
        return () => window.removeEventListener("hashchange", onHash);
    }, []);

    const select = useCallback((id: ToolId) => {
        setActive(id);
        window.location.hash = `#/quality/${id}`;
    }, []);

    return { active, select, projectName };
}
