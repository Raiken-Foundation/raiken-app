/**
 * Permission modes for the interactive REPL — Claude/Codex-style trust ladder.
 *
 *   ask        — prompt before saving or running generated tests
 *   auto-save  — save without asking; still prompt before run
 *   auto-run   — save + run without asking
 *   yolo       — same as auto-run (alias for power users)
 */

export type PermissionMode = "ask" | "auto-save" | "auto-run" | "yolo";

const ORDER: PermissionMode[] = ["ask", "auto-save", "auto-run", "yolo"];

export function cyclePermissionMode(current: PermissionMode): PermissionMode {
    const i = ORDER.indexOf(current);
    return ORDER[(i + 1) % ORDER.length];
}

export function parsePermissionMode(raw: string | undefined): PermissionMode | null {
    if (!raw) return null;
    const v = raw.trim().toLowerCase().replace(/_/g, "-");
    if (v === "ask" || v === "manual" || v === "default") return "ask";
    if (v === "auto-save" || v === "autosave" || v === "save") return "auto-save";
    if (v === "auto-run" || v === "autorun" || v === "run") return "auto-run";
    if (v === "yolo" || v === "bypass" || v === "dangerously-skip-permissions") return "yolo";
    return null;
}

export function permissionModeLabel(mode: PermissionMode): string {
    switch (mode) {
        case "ask":
            return "ask";
        case "auto-save":
            return "auto-save";
        case "auto-run":
            return "auto-run";
        case "yolo":
            return "yolo";
    }
}

/** Whether save_approval HITL should be auto-accepted. */
export function shouldAutoSave(mode: PermissionMode): boolean {
    return mode === "auto-save" || mode === "auto-run" || mode === "yolo";
}

/** Whether a saved test should be run without asking. */
export function shouldAutoRun(mode: PermissionMode): boolean {
    return mode === "auto-run" || mode === "yolo";
}
