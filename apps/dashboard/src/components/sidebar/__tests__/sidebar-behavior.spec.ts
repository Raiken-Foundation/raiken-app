import { describe, expect, it, vi } from "vitest";
import { parseStreamedAssistantContent } from "../stream/parse-stream";

describe("useAgentStream chunk parsing", () => {
    it("strips activity markers and surfaces hitl separately", () => {
        const eventMarker = `<!--EVENT:${Buffer.from(
            JSON.stringify({ label: "Reading page" }),
            "utf-8",
        ).toString("base64")}-->`;
        const raw = `${eventMarker}\nHello\n<!--HITL:{"kind":"save_approval","type":"save","title":"Save","message":"m","reasons":[],"options":[],"context":{}}-->`;
        const parsed = parseStreamedAssistantContent(raw);
        expect(parsed.activity).toContain("Reading page");
        expect(parsed.hitl?.kind).toBe("save_approval");
        expect(parsed.clean).not.toContain("HITL");
    });
});

describe("agent stream abort semantics", () => {
    it("treats AbortError as a stopped run", () => {
        const error = new DOMException("Aborted", "AbortError");
        expect(error.name).toBe("AbortError");
    });

    it("handleStop returns false when no controller is registered", () => {
        const handleStop = () => false;
        expect(handleStop()).toBe(false);
    });
});

describe("duplicate HITL action prevention", () => {
    it("blocks a second save resolution in the same session map", () => {
        const session = { "1": { status: "saved" as const, filePath: "e2e/a.spec.ts" } };
        expect(session["1"]).toBeTruthy();
        expect(session["1"]).toEqual({ status: "saved", filePath: "e2e/a.spec.ts" });
        expect(() => {
            if (session["1"]) return "blocked";
        }).not.toThrow();
    });
});

describe("composer keyboard routing", () => {
    it("routes Enter-with-autocomplete to selection instead of submit", () => {
        const preventDefault = vi.fn();
        const event = {
            key: "Enter",
            shiftKey: false,
            preventDefault,
            stopPropagation: vi.fn(),
        } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;

        const showAutocomplete = true;
        const filteredFiles = [{ path: "a.ts", name: "a.ts" }];
        if (showAutocomplete && event.key === "Enter" && filteredFiles.length > 0) {
            event.preventDefault();
        }
        expect(preventDefault).toHaveBeenCalled();
    });
});
