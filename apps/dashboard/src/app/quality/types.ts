export type ToolId = "doctor" | "impact" | "trace" | "cover" | "context";

export type StatusTone = "ok" | "warn" | "fail" | "muted";

export interface StatusStripItem {
    label: string;
    value: number | string;
    tone?: StatusTone;
}
