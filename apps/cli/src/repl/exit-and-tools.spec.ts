import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliExitError, cliExit, withThrowExit } from "./exit";
import { ToolCallRenderer } from "./tool-renderer";

describe("withThrowExit", () => {
    it("captures cliExit codes without killing the process", async () => {
        const code = await withThrowExit(async () => {
            cliExit(2);
        });
        expect(code).toBe(2);
    });

    it("returns 0 when the command completes normally", async () => {
        const code = await withThrowExit(async () => {
            /* no exit */
        });
        expect(code).toBe(0);
    });

    it("rethrows non-exit errors", async () => {
        await expect(
            withThrowExit(async () => {
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");
    });

    it("CliExitError carries the code", () => {
        const err = new CliExitError(7);
        expect(err.code).toBe(7);
        expect(err.name).toBe("CliExitError");
    });
});

describe("ToolCallRenderer", () => {
    let writes: string[];
    let originalWrite: typeof process.stderr.write;

    beforeEach(() => {
        writes = [];
        originalWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: string | Uint8Array) => {
            writes.push(typeof chunk === "string" ? chunk : chunk.toString());
            return true;
        }) as typeof process.stderr.write;
    });

    afterEach(() => {
        process.stderr.write = originalWrite;
    });

    it("collapses repeated tool calls", () => {
        const r = new ToolCallRenderer();
        r.onToolCall("click", { selector: "#a" });
        r.onToolCall("click", { selector: "#b" });
        r.onToolCall("click", { selector: "#c" });
        r.flush();
        expect(writes.join("")).toMatch(/click ×3/);
    });

    it("flushes when the tool name changes", () => {
        const r = new ToolCallRenderer();
        r.onToolCall("click", { selector: "#a" });
        r.onToolCall("fill", { selector: "#email", value: "x" });
        r.flush();
        const out = writes.join("");
        expect(out).toMatch(/click/);
        expect(out).toMatch(/fill/);
    });

    it("prints progress immediately after flushing tools", () => {
        const r = new ToolCallRenderer();
        r.onToolCall("navigate", { url: "https://x" });
        r.onProgress("Exploring", "3/8");
        expect(writes.join("")).toMatch(/navigate/);
        expect(writes.join("")).toMatch(/Exploring 3\/8/);
    });
});
