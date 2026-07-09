import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS, slashCompleter } from "./completer";

describe("slashCompleter", () => {
    it("suggests commands matching the prefix", () => {
        const [hits] = slashCompleter("/do");
        expect(hits).toContain("/doctor");
        expect(hits.every((h) => h.startsWith("/do"))).toBe(true);
    });

    it("returns all commands for bare /", () => {
        const [hits] = slashCompleter("/");
        expect(hits.length).toBe(SLASH_COMMANDS.length);
    });

    it("ignores non-slash input", () => {
        const [hits] = slashCompleter("hello");
        expect(hits).toEqual([]);
    });

    it("does not complete after a space", () => {
        const [hits] = slashCompleter("/discover http");
        expect(hits).toEqual([]);
    });
});
