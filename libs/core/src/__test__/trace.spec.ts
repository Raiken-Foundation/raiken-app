import { describe, expect, it } from "vitest";
import { parseTrace } from "../trace/trace";

describe("raiken trace: parseTrace", () => {
    it("parses V8 'at fn (path:line:col)' frames", () => {
        const trace = `
Error: boom
    at doThing (/Users/me/proj/src/foo.ts:10:5)
    at async Context.<anonymous> (/Users/me/proj/test/bar.spec.ts:32:3)
`;
        const frames = parseTrace(trace);
        expect(frames).toHaveLength(2);
        expect(frames[0]).toMatchObject({
            symbol: "doThing",
            rawPath: "/Users/me/proj/src/foo.ts",
            line: 10,
            column: 5,
        });
        expect(frames[1]?.rawPath).toContain("bar.spec.ts");
    });

    it("parses anonymous V8 frames 'at path:line:col'", () => {
        const trace = `at /Users/me/proj/src/baz.ts:1:1`;
        const frames = parseTrace(trace);
        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            rawPath: "/Users/me/proj/src/baz.ts",
            line: 1,
            column: 1,
        });
    });

    it("parses Firefox/Webkit 'fn@path:line:col' frames", () => {
        const trace = `handleClick@http://localhost:3000/src/app.ts:42:12`;
        const frames = parseTrace(trace);
        expect(frames[0]).toMatchObject({
            symbol: "handleClick",
            rawPath: "http://localhost:3000/src/app.ts",
            line: 42,
            column: 12,
        });
    });

    it("parses bare 'path:line:col' lines", () => {
        const frames = parseTrace(`src/login.ts:5:1`);
        expect(frames[0]).toMatchObject({
            rawPath: "src/login.ts",
            line: 5,
            column: 1,
        });
    });

    it("ignores node:internal frames that won't resolve", () => {
        // These parse into frames, but downstream resolve() filters them out.
        // Here we just ensure parsing doesn't throw.
        const frames = parseTrace(`at Module._compile (node:internal/modules/cjs/loader:1705:14)`);
        expect(frames).toHaveLength(1);
        expect(frames[0]?.rawPath).toBe("node:internal/modules/cjs/loader");
    });
});
