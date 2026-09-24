import { describe, expect, it } from "vitest";
import { buildNavigationFlows, formatNavigationFlows } from "../cover/flows";
import type { NavigationPath } from "../site-discovery/types";

describe("buildNavigationFlows", () => {
    const paths: NavigationPath[] = [
        {
            fromUrl: "http://app.local/",
            toUrl: "http://app.local/product/1",
            selector: "getByRole('link', { name: 'Shoes' })",
            linkText: "Shoes",
            verified: true,
        },
        {
            fromUrl: "http://app.local/product/1",
            toUrl: "http://app.local/cart",
            selector: "getByRole('button', { name: 'Add to cart' })",
            linkText: "Add to cart",
            verified: true,
        },
        {
            fromUrl: "http://app.local/cart",
            toUrl: "http://app.local/checkout",
            selector: "getByRole('link', { name: 'Checkout' })",
            linkText: "Checkout",
            verified: true,
        },
        {
            fromUrl: "http://app.local/",
            toUrl: "http://app.local/about",
            selector: "getByRole('link', { name: 'About' })",
            linkText: "About",
            verified: true,
        },
    ];

    it("builds multi-step chains for a cart scenario", () => {
        const flows = buildNavigationFlows(paths, "add a product to the cart then checkout");
        expect(flows.length).toBeGreaterThan(0);
        const labels = flows.map((f) => f.label).join(" | ");
        expect(labels).toMatch(/cart|checkout|product/i);
        expect(flows.some((f) => f.steps.length >= 2)).toBe(true);
        expect(flows[0]?.selectors.length).toBeGreaterThan(0);
    });

    it("caps depth and skips cycles", () => {
        const cyclic: NavigationPath[] = [
            {
                fromUrl: "http://app.local/a",
                toUrl: "http://app.local/b",
                selector: "a",
                linkText: "B",
                verified: true,
            },
            {
                fromUrl: "http://app.local/b",
                toUrl: "http://app.local/a",
                selector: "b",
                linkText: "A",
                verified: true,
            },
        ];
        const flows = buildNavigationFlows(cyclic, "navigate");
        for (const flow of flows) {
            expect(flow.steps.length).toBeLessThanOrEqual(3);
            const urls = flow.steps.map((s) => s.toUrl);
            expect(new Set(urls).size).toBe(urls.length);
        }
    });

    it("formats flows for the prompt", () => {
        const flows = buildNavigationFlows(paths, "checkout");
        const text = formatNavigationFlows(flows);
        expect(text).toContain("KNOWN NAVIGATION PATHS");
        expect(text).toContain("→");
    });
});
