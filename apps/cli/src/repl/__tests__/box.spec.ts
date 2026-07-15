import { describe, expect, it } from "vitest";
import { renderBox } from "../box";

const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const stripAnsi = (s: string) => s.replace(ANSI_PATTERN, "");

describe("renderBox", () => {
    it("pads short lines to a fixed inner width", () => {
        const out = renderBox(["hi"], 20);
        const row = stripAnsi(out.split("\n")[1]);
        expect(row).toBe(`│ hi${" ".repeat(14)} │`);
    });

    it("clips overlong styled lines by visible width without cutting escape codes", () => {
        const styled = `${ESC}[37m${"a".repeat(10)}${ESC}[39m${ESC}[2m${"b".repeat(10)}${ESC}[22m`;
        const out = renderBox([styled], 20); // inner width 16
        const row = out.split("\n")[1];
        // Every visible row stays exactly the box width.
        expect(stripAnsi(row).length).toBe(20);
        expect(stripAnsi(row)).toContain("a".repeat(10));
        // No escape sequence was cut mid-way: strip must remove them all.
        expect(stripAnsi(row)).not.toContain(String.fromCharCode(27));
        // Truncation ends with a reset so the open style can't bleed
        // past the right wall.
        expect(row).toContain(`${ESC}[0m`);
    });
});
