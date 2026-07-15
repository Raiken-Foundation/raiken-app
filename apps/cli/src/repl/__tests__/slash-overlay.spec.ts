import { describe, expect, it } from "vitest";
import { SlashMenuOverlay } from "../slash-overlay";

function outputHarness() {
    const chunks: string[] = [];
    const output = {
        columns: 100,
        write(chunk: string | Uint8Array) {
            chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
            return true;
        },
    } as unknown as NodeJS.WriteStream;
    return { output, chunks };
}

describe("SlashMenuOverlay", () => {
    it("draws and filters the command menu while preserving input", () => {
        const { output, chunks } = outputHarness();
        const overlay = new SlashMenuOverlay(output);

        overlay.sync({
            enabled: true,
            line: "/",
            cursor: 1,
            cursorRows: 0,
            prompt: "› ",
        });
        expect(chunks.join("")).toContain("Slash commands");
        expect(chunks.join("")).toContain("› /");

        chunks.length = 0;
        overlay.sync({
            enabled: true,
            line: "/do",
            cursor: 3,
            cursorRows: 0,
            prompt: "› ",
        });
        const filtered = chunks.join("");
        expect(filtered).toContain("/doctor");
        expect(filtered).not.toContain("/plan ");
        expect(filtered).toContain("› /do");
    });

    it("clears the menu when command arguments begin", () => {
        const { output, chunks } = outputHarness();
        const overlay = new SlashMenuOverlay(output);
        overlay.sync({
            enabled: true,
            line: "/test",
            cursor: 5,
            cursorRows: 0,
            prompt: "› ",
        });

        chunks.length = 0;
        overlay.sync({
            enabled: true,
            line: "/test e2e/login.spec.ts",
            cursor: 23,
            cursorRows: 0,
            prompt: "› ",
        });
        expect(overlay.visible).toBe(false);
        expect(chunks.join("")).toContain("› /test e2e/login.spec.ts");
    });

    it("removes suggestions from scrollback after submission", () => {
        const { output, chunks } = outputHarness();
        const overlay = new SlashMenuOverlay(output);
        overlay.sync({
            enabled: true,
            line: "/doctor",
            cursor: 7,
            cursorRows: 0,
            prompt: "› ",
        });

        chunks.length = 0;
        overlay.finish("› ", "/doctor");
        expect(overlay.visible).toBe(false);
        expect(chunks.join("")).toContain("› /doctor\n");
    });
});
