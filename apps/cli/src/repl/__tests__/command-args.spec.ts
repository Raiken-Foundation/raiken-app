import { describe, expect, it } from "vitest";
import {
    booleanFlag,
    parseCommandArgs,
    stringFlag,
    stringFlags,
    tokenizeCommandArgs,
} from "../command-args";

describe("slash command arguments", () => {
    it("tokenizes quoted values and escapes", () => {
        expect(tokenizeCommandArgs('"login flow" --output "e2e/login test.spec.ts"')).toEqual([
            "login flow",
            "--output",
            "e2e/login test.spec.ts",
        ]);
    });

    it("parses long, short, boolean, and equals flags", () => {
        const parsed = parseCommandArgs(
            '--dry-run checkout --ticket SAC-42 -o "e2e/checkout.spec.ts" --limit=5',
        );
        expect(parsed.positionals).toEqual(["checkout"]);
        expect(stringFlag(parsed, "ticket")).toBe("SAC-42");
        expect(stringFlag(parsed, "o")).toBe("e2e/checkout.spec.ts");
        expect(stringFlag(parsed, "limit")).toBe("5");
        expect(booleanFlag(parsed, "dryRun")).toBe(true);
    });

    it("retains repeated flags as arrays", () => {
        const parsed = parseCommandArgs(
            "--storage token=abc --storage tenant=raiken --domain app.example.com",
        );
        expect(stringFlags(parsed, "storage")).toEqual(["token=abc", "tenant=raiken"]);
        expect(stringFlag(parsed, "domain")).toBe("app.example.com");
    });

    it("supports -- to force positional parsing", () => {
        const parsed = parseCommandArgs("-- --literal -value");
        expect(parsed.positionals).toEqual(["--literal", "-value"]);
    });

    it("keeps mid-word apostrophes literal in free text", () => {
        expect(tokenizeCommandArgs("user's checkout flow")).toEqual(["user's", "checkout", "flow"]);
    });

    it("still opens quotes after --key=", () => {
        const parsed = parseCommandArgs('--output="e2e/login test.spec.ts"');
        expect(stringFlag(parsed, "output")).toBe("e2e/login test.spec.ts");
    });

    it("treats known boolean flags as booleans even when followed by a positional", () => {
        const parsed = parseCommandArgs("--husky install");
        expect(booleanFlag(parsed, "husky")).toBe(true);
        expect(parsed.positionals).toEqual(["install"]);

        const organize = parseCommandArgs("--yes --tests-only");
        expect(booleanFlag(organize, "yes", "y")).toBe(true);
        expect(booleanFlag(organize, "testsOnly")).toBe(true);

        const report = parseCommandArgs("--no-embed-screenshots report.json");
        expect(booleanFlag(report, "noEmbedScreenshots")).toBe(true);
        expect(report.positionals).toEqual(["report.json"]);
    });
});
