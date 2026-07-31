import type { ToolId } from "./types";

export const TOOLS: { id: ToolId; label: string; brief: string }[] = [
    {
        id: "doctor",
        label: "doctor",
        brief: "Static audit of your e2e suite for the patterns that cause flakes.",
    },
    {
        id: "impact",
        label: "impact",
        brief: "Tests affected by the current diff, ranked by graph confidence.",
    },
    {
        id: "trace",
        label: "trace",
        brief: "Reverse a stack trace into the existing tests that exercise that path.",
    },
    {
        id: "cover",
        label: "cover",
        brief: "Draft a Playwright spec from a scenario, AC id, or symbol name.",
    },
    {
        id: "context",
        label: "context",
        brief: "Write raiken.ctx.md — a portable briefing for IDE agents.",
    },
];

export const DEFAULT_TOOL: ToolId = "doctor";
