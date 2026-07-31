import { DEFAULT_TOOL, TOOLS } from "./constants";
import type { ToolId } from "./types";

export function getToolFromHash(): ToolId {
    const m = window.location.hash.match(/#\/quality\/([a-z]+)/);
    const id = m?.[1] as ToolId | undefined;
    return TOOLS.some((t) => t.id === id) ? (id as ToolId) : DEFAULT_TOOL;
}

export function shortSha(sha: string): string {
    return sha ? sha.slice(0, 7) : "—";
}

import { formatTrpcClientErrorMessage } from "@raiken/shared";

export function formatErrorMessage(error: unknown): string {
    return formatTrpcClientErrorMessage(error);
}

export function buildImpactCommandParts(options: {
    base: string;
    head: string;
    staged: boolean;
    threshold: string;
}): string[] {
    const cmd = ["ci", "--skip-run"];
    if (options.staged) cmd.push("--staged");
    else {
        if (options.base.trim()) cmd.push("--base", options.base.trim());
        if (options.head.trim()) cmd.push("--head", options.head.trim());
    }
    if (options.threshold.trim() && options.threshold !== "0.1") {
        cmd.push("--confidence", options.threshold.trim());
    }
    return cmd;
}

export function buildDoctorCommandParts(testDir: string): string[] {
    const cmd = ["doctor"];
    if (testDir.trim()) cmd.push("--test-dir", testDir.trim());
    return cmd;
}

export function buildTraceCommandParts(minConfidence: string): string[] {
    const cmd = ["trace", "--stdin"];
    if (minConfidence !== "0") cmd.push("--confidence", minConfidence);
    return cmd;
}

export function buildCoverCommandParts(options: {
    target: string;
    ticketId: string;
    dryRun: boolean;
}): string[] {
    const cmd = ["cover"];
    if (options.target.trim()) cmd.push(`"${options.target.trim()}"`);
    else cmd.push("<target>");
    if (options.ticketId.trim()) cmd.push("--ticket", options.ticketId.trim());
    if (options.dryRun) cmd.push("--dry-run");
    return cmd;
}

export function buildContextCommandParts(options: {
    maxRows: string;
    includeImpact: boolean;
}): string[] {
    const cmd = ["context"];
    if (options.maxRows && options.maxRows !== "25") cmd.push("--max-rows", options.maxRows);
    if (!options.includeImpact) cmd.push("--no-impact");
    return cmd;
}
