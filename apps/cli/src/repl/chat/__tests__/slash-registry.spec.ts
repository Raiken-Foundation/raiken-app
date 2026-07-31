import { describe, expect, it } from "vitest";
import {
    assertSlashDispatchParity,
    createSlashDispatcher,
    SLASH_DISPATCH_HANDLERS,
} from "../slash/dispatch";
import {
    listRegisteredSlashCommandNames,
    matchSlashCommands,
    resolveSlashCommand,
    SLASH_COMMAND_REGISTRY,
} from "../slash/registry";

describe("slash command registry", () => {
    it("every registered command has a dispatch handler", () => {
        expect(() => assertSlashDispatchParity()).not.toThrow();
        const registered = listRegisteredSlashCommandNames();
        for (const name of registered) {
            expect(SLASH_DISPATCH_HANDLERS[name]).toBeTypeOf("function");
        }
    });

    it("resolves aliases to canonical handlers", () => {
        expect(resolveSlashCommand("kb")?.name).toBe("knowledge");
        expect(resolveSlashCommand("permissions")?.name).toBe("mode");
        expect(resolveSlashCommand("quit")?.name).toBe("exit");
        expect(SLASH_DISPATCH_HANDLERS[resolveSlashCommand("kb")?.name]).toBeDefined();
    });

    it("covers the same command surface as before decomposition", () => {
        expect(SLASH_COMMAND_REGISTRY.map((command) => command.name)).toEqual(
            expect.arrayContaining([
                "help",
                "plan",
                "mode",
                "discover",
                "goto",
                "save",
                "clear",
                "exit",
                "organize",
                "hooks",
            ]),
        );
        expect(matchSlashCommands("rep").map((command) => command.name)).toContain("report");
    });
});

describe("slash dispatch", () => {
    it("routes unknown commands with suggestions", async () => {
        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (...args: unknown[]) => {
            logs.push(args.map(String).join(" "));
        };
        try {
            const ctx = {
                shutdown: async () => undefined,
            } as never;
            const dispatch = createSlashDispatcher(ctx);
            await dispatch("/nope");
            expect(logs.join("\n")).toMatch(/Unknown command/);
        } finally {
            console.log = originalLog;
        }
    });
});
