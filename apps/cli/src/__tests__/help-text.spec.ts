/**
 * The grouped help replaces commander's generated list, so a command added to
 * `bin.ts` no longer shows up on its own — it becomes invisible unless someone
 * remembers to add it here. This test is that reminder.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { HELP_GROUPS, renderMainHelp } from "../help-text";

/** Top-level command names registered on `program` (not nested subcommands). */
function registeredTopLevelCommands(): string[] {
    const source = fs.readFileSync(path.join(__dirname, "..", "bin.ts"), "utf-8");
    const names = new Set<string>();
    // `program\n    .command("cover <target>")`, including the `const x = program`
    // form. Anything chained off another variable (e.g. `hooks`) is nested.
    for (const match of source.matchAll(/(?:^|=\s*)program\s*\n\s*\.command\(\s*["'`]([\w-]+)/gm)) {
        const name = match[1];
        if (name) names.add(name);
    }
    return [...names];
}

describe("grouped help", () => {
    const help = renderMainHelp();

    it("documents every top-level command", () => {
        const registered = registeredTopLevelCommands();
        // Guard the guard: a regex that matched nothing would pass vacuously.
        expect(registered.length).toBeGreaterThan(20);

        const listed = new Set(
            HELP_GROUPS.flatMap((group) =>
                group.entries.map((item) => item.invocation.split(/\s/)[0]),
            ),
        );
        const missing = registered.filter((name) => !listed.has(name));
        expect(missing, `add these to HELP_GROUPS in help-text.ts: ${missing.join(", ")}`).toEqual(
            [],
        );
    });

    it("names no command that does not exist", () => {
        const registered = new Set(registeredTopLevelCommands());
        const invented = HELP_GROUPS.flatMap((group) => group.entries)
            .map((item) => item.invocation.split(/\s/)[0])
            .filter((name) => name !== "raiken" && !registered.has(name));
        expect(invented).toEqual([]);
    });

    it("leads with the commands a first run needs", () => {
        expect(HELP_GROUPS[0]?.title).toBe("Set up");
        for (const command of [
            "raiken init",
            "raiken doctor --fix",
            "raiken cover",
            "raiken test",
        ]) {
            expect(help).toContain(command);
        }
    });

    it("keeps the auth-before-cover rule visible", () => {
        expect(help).toContain("raiken auth");
        expect(help).toMatch(/behind a login/i);
    });
});
