import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
    matchSlashCommands,
    parseSlashLine,
    renderSlashMenu,
    resolveSlashCommand,
    SLASH_COMMAND_REGISTRY,
    SLASH_COMMANDS,
    shouldShowSlashMenu,
    slashCompleter,
} from "../completer";

describe("slashCompleter", () => {
    it("suggests commands matching the prefix", () => {
        const [hits] = slashCompleter("/do");
        expect(hits).toContain("/doctor");
        expect(hits.every((h) => h.startsWith("/do"))).toBe(true);
    });

    it("returns no completions for bare / (the overlay lists commands instead)", () => {
        // Multiple hits would make readline print its own completion list
        // below the input, breaking the overlay's row accounting.
        const [hits] = slashCompleter("/");
        expect(hits).toEqual([]);
    });

    it("completes an ambiguous prefix to the longest common prefix, never a list", () => {
        // /sc → screenshot only (unambiguous)
        expect(slashCompleter("/scr")[0]).toEqual(["/screenshot"]);
        // /s → many matches, nothing shared beyond "/s" → no-op Tab
        expect(slashCompleter("/s")[0]).toEqual([]);
        // /se → search/sessions/session share "/se" only → no-op Tab
        expect(slashCompleter("/se")[0]).toEqual([]);
        // Never more than one hit, for any command prefix.
        for (const name of SLASH_COMMANDS) {
            for (let i = 1; i <= name.length; i++) {
                const [hits] = slashCompleter(`/${name.slice(0, i)}`);
                expect(hits.length).toBeLessThanOrEqual(1);
            }
        }
    });

    it("ignores non-slash input", () => {
        const [hits] = slashCompleter("hello");
        expect(hits).toEqual([]);
    });

    it("does not complete after a space", () => {
        const [hits] = slashCompleter("/discover http");
        expect(hits).toEqual([]);
    });

    it("renders a compact command discovery menu", () => {
        const menu = renderSlashMenu().join("\n");
        expect(menu).toContain("/help");
        expect(menu).toContain("/plan");
        expect(menu).toContain("Tab to complete");
    });

    it("filters the visible menu as the user types", () => {
        const broad = renderSlashMenu("/d").join("\n");
        expect(broad).toContain("/discover");
        expect(broad).toContain("/doctor");
        expect(broad).not.toContain("/mode");

        const menu = renderSlashMenu("/do").join("\n");
        expect(menu).toContain("/doctor");
        expect(menu).not.toContain("/plan ");
        expect(menu).not.toContain("/snapshot");
    });

    it("resolves aliases through the same registry", () => {
        expect(resolveSlashCommand("kb")?.name).toBe("knowledge");
        expect(resolveSlashCommand("permissions")?.name).toBe("mode");
        expect(resolveSlashCommand("quit")?.name).toBe("exit");
    });

    it("hides completion and the menu once arguments begin", () => {
        expect(shouldShowSlashMenu("/discover")).toBe(true);
        expect(shouldShowSlashMenu("/discover ")).toBe(false);
        expect(parseSlashLine("/discover https://example.com")).toEqual({
            command: "discover",
            args: "https://example.com",
            hasArgs: true,
        });
    });

    it("contains every high-value executable command", () => {
        expect(SLASH_COMMANDS).toEqual(
            expect.arrayContaining([
                "auth",
                "discover",
                "test",
                "report",
                "ci",
                "doctor",
                "organize",
                "hooks",
            ]),
        );
        expect(matchSlashCommands("rep").map((command) => command.name)).toContain("report");
    });

    // Registry entries drive Tab completion, the live menu overlay, and
    // /help — but dispatch lives separately in chat.ts's `handleSlash`
    // (handlers close over live browser/session/tRPC state, so it can't be
    // data-driven from here). This is a lightweight static guard against the
    // two drifting apart: a registry entry with no matching dispatch site
    // shows up everywhere as a real command but fails with "Unknown
    // command" the moment someone runs it (exactly what happened when
    // `organize` shipped in bin.ts before it was wired into the REPL).
    it("every registered slash command has a dispatch site in chat.ts", () => {
        const chatSource = fs.readFileSync(path.join(__dirname, "../../commands/chat.ts"), "utf-8");
        const unhandled = SLASH_COMMAND_REGISTRY.filter((command) => {
            const asCaseOrCheck = `"${command.name}"`;
            const asObjectKey = `${command.name}:`;
            return !chatSource.includes(asCaseOrCheck) && !chatSource.includes(asObjectKey);
        });
        expect(unhandled.map((command) => command.name)).toEqual([]);
    });
});
