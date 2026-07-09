import { describe, expect, it } from "vitest";
import {
    cyclePermissionMode,
    parsePermissionMode,
    shouldAutoRun,
    shouldAutoSave,
} from "./permissions";

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
});
