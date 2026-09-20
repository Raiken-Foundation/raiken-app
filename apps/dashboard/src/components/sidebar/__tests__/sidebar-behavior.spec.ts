import { describe, expect, it } from "vitest";
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
