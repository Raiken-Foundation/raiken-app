import { BrowserSession, getProvider, resolveAIConfig } from "@raiken/core";
import { appRouter } from "@raiken/shared";
import { accent, dim } from "../agent-stream";
import { formatDiscoverChip, getBackgroundDiscoverStatus } from "./background-discover";
import { type PermissionMode, permissionModeLabel } from "./permissions";

export interface StatusSnapshot {
    model: string;
    provider: string;
    url: string | null;
    pagesKnown: number | null;
    mode: PermissionMode;
    headed: boolean;
    planMode: boolean;
    discoverChip: string | null;
}

/**
 * Gather the bits shown in the always-on status strip above the prompt.
 * Best-effort: any failure degrades to "—" rather than breaking the REPL.
 */
export async function gatherStatusSnapshot(
    projectPath: string,
    mode: PermissionMode,
    planMode = false,
): Promise<StatusSnapshot> {
    const ai = resolveAIConfig(projectPath);
    const provider = getProvider(ai.provider);
    const model = shortModel(ai.model);

    let url: string | null = null;
    try {
        const session = BrowserSession.getInstance(projectPath);
        if (session.isActive()) {
            const current = session.getCurrentUrl();
            url = current && current !== "about:blank" ? current : null;
        }
    } catch {
        /* browser not up */
    }

    let pagesKnown: number | null = null;
    try {
        const caller = appRouter.createCaller({ projectPath });
        const stats = await caller.getDiscoveryStats({});
        pagesKnown = typeof stats?.pagesCount === "number" ? stats.pagesCount : null;
    } catch {
        /* discovery DB unavailable */
    }

    return {
        model,
        provider: provider.label,
        url,
        pagesKnown,
        mode,
        headed: process.env.RAIKEN_HEADLESS !== "1",
        planMode,
        discoverChip: formatDiscoverChip(getBackgroundDiscoverStatus()),
    };
}

/** Truncate a long model id to the trailing segment (e.g. claude-sonnet-4.5). */
function shortModel(model: string): string {
    const parts = model.split("/");
    const leaf = parts[parts.length - 1] || model;
    return leaf.length > 28 ? `${leaf.slice(0, 25)}…` : leaf;
}

/** Truncate a URL for the status strip. */
function shortUrl(url: string): string {
    try {
        const u = new URL(url);
        const path = u.pathname === "/" ? "" : u.pathname;
        const full = `${u.host}${path}`;
        return full.length > 40 ? `${full.slice(0, 37)}…` : full;
    } catch {
        return url.length > 40 ? `${url.slice(0, 37)}…` : url;
    }
}

/**
 * Render the Claude/Codex-style status strip above the prompt.
 * Example: `sonnet-4.5 · headed · app/login · 42 pages · ask · plan`
 */
export function renderStatusStrip(snap: StatusSnapshot): void {
    const parts: string[] = [accent(snap.model), dim(snap.headed ? "headed" : "headless")];
    if (snap.url) parts.push(dim(shortUrl(snap.url)));
    if (snap.pagesKnown !== null && snap.pagesKnown > 0) {
        parts.push(dim(`${snap.pagesKnown} page${snap.pagesKnown === 1 ? "" : "s"}`));
    } else {
        parts.push(dim("no knowledge"));
    }
    parts.push(accent(permissionModeLabel(snap.mode)));
    if (snap.planMode) parts.push(accent("plan"));
    if (snap.discoverChip) parts.push(dim(snap.discoverChip));
    console.log(dim("  ") + parts.join(dim("  ·  ")));
}
