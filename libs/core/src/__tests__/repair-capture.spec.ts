/**
 * Repair live-capture: open the failing page when discovery misses it.
 */
import { describe, expect, it } from "vitest";
import {
    discoveryCoversUrl,
    extractFirstGotoTarget,
    resolveFailureUrl,
    shouldLiveCaptureRepairPage,
} from "../cover/repair-capture";

describe("repair live-capture triggers", () => {
    it("extracts the first page.goto target", () => {
        expect(
            extractFirstGotoTarget(`await page.goto('/login');\nawait page.goto('/dashboard');`),
        ).toBe("/login");
        expect(extractFirstGotoTarget("no navigation")).toBeNull();
    });

    it("resolves relative gotos against baseURL", () => {
        expect(resolveFailureUrl("/login", "http://localhost:3000")).toBe(
            "http://localhost:3000/login",
        );
        expect(resolveFailureUrl("https://app.example/x", "http://localhost:3000")).toBe(
            "https://app.example/x",
        );
        expect(resolveFailureUrl("/login", null)).toBeNull();
    });

    it("detects when discovery snapshots already cover the URL", () => {
        const snaps = [`Page: http://localhost:3000/login\n• textbox: "Email"`];
        expect(discoveryCoversUrl("http://localhost:3000/login", snaps)).toBe(true);
        expect(discoveryCoversUrl("http://localhost:3000/cart", snaps)).toBe(false);
    });

    it("requests live capture when the entry URL is missing from discovery", () => {
        const decision = shouldLiveCaptureRepairPage(
            `await page.goto('/cart');\nawait expect(page.getByText('Cart')).toBeVisible();`,
            "Timeout waiting for getByText('Cart')",
            {
                snapshots: [`Page: http://localhost:3000/login\n• textbox: "Email"`],
                baseURL: "http://localhost:3000",
                sourceSelectors: [],
            },
        );
        expect(decision.url).toBe("http://localhost:3000/cart");
        expect(decision.reasons.some((r) => r.includes("no matching discovery snapshot"))).toBe(
            true,
        );
    });

    it("skips live capture when discovery already has the entry page", () => {
        const decision = shouldLiveCaptureRepairPage(
            `await page.goto('/login');\nawait page.getByLabel('Email').fill('a');`,
            "Error: expect(locator).toBeVisible()",
            {
                snapshots: [`Page: http://localhost:3000/login\n• textbox: "Email"`],
                baseURL: "http://localhost:3000",
                sourceSelectors: [],
            },
        );
        expect(decision.reasons).toEqual([]);
    });
});
