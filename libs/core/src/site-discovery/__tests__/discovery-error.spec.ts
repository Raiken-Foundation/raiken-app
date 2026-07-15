import { describe, expect, it } from "vitest";
import { formatDiscoveryError } from "../discovery-error";

describe("formatDiscoveryError", () => {
    it("expands generic AggregateError messages into concrete causes", () => {
        const error = new AggregateError(
            [
                new Error("SQLITE_CONSTRAINT: duplicate page URL"),
                new Error("page.goto: net::ERR_CONNECTION_RESET"),
            ],
            "Received one or more errors",
        );

        const formatted = formatDiscoveryError(error);
        expect(formatted).toContain("Multiple discovery errors");
        expect(formatted).toContain("SQLITE_CONSTRAINT");
        expect(formatted).toContain("ERR_CONNECTION_RESET");
        expect(formatted).not.toBe("Received one or more errors");
    });

    it("deduplicates repeated nested errors", () => {
        const error = new AggregateError(
            [new Error("Browser closed"), new Error("Browser closed")],
            "Received one or more errors",
        );
        expect(formatDiscoveryError(error)).toBe("Browser closed (repeated 2 times)");
    });

    it("follows ordinary error causes", () => {
        const error = new Error("Discovery wrapper", {
            cause: new Error("Request timed out after 30000ms"),
        });
        const formatted = formatDiscoveryError(error);
        expect(formatted).toContain("Discovery wrapper");
        expect(formatted).toContain("Request timed out");
    });
});
