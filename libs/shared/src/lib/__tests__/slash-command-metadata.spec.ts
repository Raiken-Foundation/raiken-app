import { describe, expect, it } from "vitest";
import { findSharedSlashMetadata, SHARED_SLASH_COMMAND_METADATA } from "../slash-command-metadata";

describe("shared slash command metadata", () => {
    it("resolves canonical names and aliases", () => {
        expect(findSharedSlashMetadata("help")?.name).toBe("help");
        expect(findSharedSlashMetadata("?")?.name).toBe("help");
        expect(findSharedSlashMetadata("discovery")?.name).toBe("discover");
        expect(findSharedSlashMetadata("impact")?.name).toBe("ci");
    });

    it("lists only cross-surface commands", () => {
        expect(SHARED_SLASH_COMMAND_METADATA.map((entry) => entry.name)).not.toContain("goto");
        expect(SHARED_SLASH_COMMAND_METADATA.map((entry) => entry.name)).toContain("test");
    });
});
