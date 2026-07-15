import { describe, expect, it } from "vitest";
import {
    cyclePermissionMode,
    parsePermissionMode,
    permissionModeToAutonomyOverride,
    shouldAutoRun,
    shouldAutoSave,
} from "../permissions";

describe("permission modes", () => {
    it("cycles ask → auto-save → auto-run → yolo → ask", () => {
        expect(cyclePermissionMode("ask")).toBe("auto-save");
        expect(cyclePermissionMode("auto-save")).toBe("auto-run");
        expect(cyclePermissionMode("auto-run")).toBe("yolo");
        expect(cyclePermissionMode("yolo")).toBe("ask");
    });

    it("parses aliases", () => {
        expect(parsePermissionMode("manual")).toBe("ask");
        expect(parsePermissionMode("autosave")).toBe("auto-save");
        expect(parsePermissionMode("auto_run")).toBe("auto-run");
        expect(parsePermissionMode("YOLO")).toBe("yolo");
        expect(parsePermissionMode("nope")).toBeNull();
    });

    it("gates save/run correctly", () => {
        expect(shouldAutoSave("ask")).toBe(false);
        expect(shouldAutoSave("auto-save")).toBe(true);
        expect(shouldAutoRun("auto-save")).toBe(false);
        expect(shouldAutoRun("auto-run")).toBe(true);
        expect(shouldAutoRun("yolo")).toBe(true);
    });

    // Regression coverage for the /mode → graph autonomy wiring: cycling
    // /mode used to only relabel the status strip while the graph kept
    // reading whatever autoSaveTests/autoRunTests happened to be on disk, so
    // e.g. `/mode yolo` silently did nothing to actual agent behavior.
    it("maps every permission mode to the matching autonomy override", () => {
        expect(permissionModeToAutonomyOverride("ask")).toEqual({
            autoSaveTests: false,
            autoRunTests: false,
        });
        expect(permissionModeToAutonomyOverride("auto-save")).toEqual({
            autoSaveTests: true,
            autoRunTests: false,
        });
        expect(permissionModeToAutonomyOverride("auto-run")).toEqual({
            autoSaveTests: true,
            autoRunTests: true,
        });
        expect(permissionModeToAutonomyOverride("yolo")).toEqual({
            autoSaveTests: true,
            autoRunTests: true,
        });
    });

    it("never sets autoCorrect/autoLearn — those stay driven by raiken.config.json", () => {
        const override = permissionModeToAutonomyOverride("yolo");
        expect(override.autoCorrect).toBeUndefined();
        expect(override.autoLearn).toBeUndefined();
    });
});
