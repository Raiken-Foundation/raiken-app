import { describe, expect, it } from "vitest";
import {
    decodeAgentMarkerJson,
    decodeHitlPayload,
    extractHitlMarker,
    parseAgentActivity,
    splitAgentStreamChunk,
} from "../agent-stream-markers";

const RAW_HITL = {
    kind: "save_approval",
    type: "save",
    title: "Approve test save",
    testCode: "test('x', async () => {});",
    suggestedPath: "e2e/example.spec.ts",
};

const LEGACY_HITL_MARKER = `<!--HITL:${JSON.stringify(RAW_HITL)}-->`;
const BASE64_HITL_MARKER = `<!--HITL:${Buffer.from(JSON.stringify(RAW_HITL), "utf-8").toString("base64")}-->`;

const PROGRESS_EVENT = {
    kind: "progress",
    label: "Reading page",
    detail: "https://example.com",
};
const EVENT_MARKER = `<!--EVENT:${Buffer.from(JSON.stringify(PROGRESS_EVENT), "utf-8").toString("base64")}-->`;

describe("agent stream markers", () => {
    it("decodes base64 and legacy raw JSON HITL payloads identically", () => {
        expect(
            decodeHitlPayload(BASE64_HITL_MARKER.match(/<!--HITL:([\s\S]*?)-->/)?.[1] ?? ""),
        ).toMatchObject(RAW_HITL);
        expect(
            decodeHitlPayload(LEGACY_HITL_MARKER.match(/<!--HITL:([\s\S]*?)-->/)?.[1] ?? ""),
        ).toMatchObject(RAW_HITL);
    });

    it("parses activity markers and dedupes consecutive labels", () => {
        const raw = `Working${EVENT_MARKER}${EVENT_MARKER}Done`;
        expect(parseAgentActivity(raw)).toEqual({
            clean: "WorkingDone",
            activity: ["Reading page https://example.com"],
        });
    });

    it("leaves partial markers in text until the closing delimiter arrives", () => {
        const partial = "hello <!--HITL:eyJ0ZXN";
        expect(splitAgentStreamChunk(partial)).toEqual({
            text: partial,
            hitl: null,
            progress: [],
        });
        expect(extractHitlMarker(partial)).toEqual({ clean: partial, hitl: null });
    });

    it("strips complete markers from a mixed chunk", () => {
        const chunk = `Draft${EVENT_MARKER}${BASE64_HITL_MARKER}`;
        expect(splitAgentStreamChunk(chunk)).toEqual({
            text: "Draft",
            hitl: expect.objectContaining(RAW_HITL),
            progress: [{ label: "Reading page", detail: "https://example.com" }],
        });
        expect(parseAgentActivity(chunk).clean).toBe(`Draft${BASE64_HITL_MARKER}`);
        expect(extractHitlMarker(parseAgentActivity(chunk).clean)).toEqual({
            clean: "Draft",
            hitl: expect.objectContaining(RAW_HITL),
        });
    });

    it("returns null for malformed marker payloads", () => {
        expect(decodeAgentMarkerJson("not-json")).toBeNull();
        expect(decodeHitlPayload("%%%")).toBeNull();
    });
});

/**
 * Golden vectors shared by CLI and dashboard parsers. Any change here should
 * keep cross-surface behavior aligned.
 */
describe("agent stream marker goldens", () => {
    const cases = [
        {
            name: "legacy hitl",
            marker: LEGACY_HITL_MARKER,
            kind: "save_approval",
        },
        {
            name: "base64 hitl",
            marker: BASE64_HITL_MARKER,
            kind: "save_approval",
        },
    ] as const;

    it.each(cases)("extractHitlMarker($name)", ({ marker, kind }) => {
        const { hitl } = extractHitlMarker(marker);
        expect(hitl?.["kind"]).toBe(kind);
    });

    it("splitAgentStreamChunk matches dashboard activity formatting", () => {
        const { progress } = splitAgentStreamChunk(EVENT_MARKER);
        expect(progress[0]?.label).toBe("Reading page");
        expect(progress[0]?.detail).toBe("https://example.com");
        const { activity } = parseAgentActivity(EVENT_MARKER);
        expect(activity).toEqual(["Reading page https://example.com"]);
    });

    it("decodeAgentMarkerJson decodes EVENT payloads", () => {
        const payload = EVENT_MARKER.match(/<!--EVENT:([A-Za-z0-9+/=]+?)-->/)?.[1] ?? "";
        expect(decodeAgentMarkerJson(payload)).toEqual(PROGRESS_EVENT);
    });
});
