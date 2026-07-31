import { describe, expect, it } from "vitest";
import { formatUnifiedDiff } from "../diff";

describe("formatUnifiedDiff", () => {
    it("returns an empty string for identical inputs", () => {
        expect(formatUnifiedDiff("a\nb\n", "a\nb\n")).toBe("");
    });

    it("marks added and removed lines with unified hunk headers", () => {
        const diff = formatUnifiedDiff(
            "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
            "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nNINE\nten\n",
            { plain: true, fromLabel: "a/spec.ts", toLabel: "b/spec.ts" },
        );
        expect(diff).toContain("--- a/spec.ts");
        expect(diff).toContain("+++ b/spec.ts");
        expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
        expect(diff).toContain("-nine");
        expect(diff).toContain("+NINE");
        // Context lines surround the change.
        expect(diff).toContain(" seven");
    });

    it("splits distant changes into separate hunks", () => {
        const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"].join("\n");
        const after = ["ONE", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "TWELVE"].join(
            "\n",
        );
        const diff = formatUnifiedDiff(before, after, { plain: true, context: 2 });
        const hunks = diff.match(/@@ /g) ?? [];
        expect(hunks.length).toBe(2);
    });

    it("merges nearby changes into one hunk", () => {
        const diff = formatUnifiedDiff("a\nb\nc\nd\ne\nf\ng\n", "a\nB\nc\nd\ne\nF\ng\n", {
            plain: true,
            context: 3,
        });
        const hunks = diff.match(/@@ /g) ?? [];
        expect(hunks.length).toBe(1);
        expect(diff).toContain("-b");
        expect(diff).toContain("+B");
        expect(diff).toContain("-f");
        expect(diff).toContain("+F");
    });

    it("handles pure insertions at the top", () => {
        const diff = formatUnifiedDiff("b\nc\n", "a\nb\nc\n", { plain: true });
        expect(diff).toContain("+a");
        expect(diff).not.toContain("-a");
        expect(diff).toContain(" b");
    });
});
