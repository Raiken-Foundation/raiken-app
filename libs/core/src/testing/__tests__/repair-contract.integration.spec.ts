import { AIMessage } from "@langchain/core/messages";
import { expect as playwrightExpect } from "@playwright/test";
import { chromium } from "playwright";
import { expect, it, vi } from "vitest";
import { executeRepairAttempt } from "../repair-attempt";

it("repairs a locator while the same accepted assertion still detects a broken price", async () => {
    const original = `import {test, expect} from '@playwright/test'; test('cart total', async ({page}) => { await expect(page.getByTestId('old-total')).toHaveText('$59.00'); });`;
    const mechanical = original.replace("old-total", "total");
    const model = { invoke: vi.fn().mockResolvedValue(new AIMessage(mechanical)) };
    const input = {
        projectPath: process.cwd(),
        testDraft: original,
        testRunResult: [
            {
                testFile: "cart.spec.ts",
                testName: "cart total",
                status: "failed" as const,
                duration: 1,
                error: { message: "locator resolved to 0 elements" },
            },
        ],
        repairAttempts: 0,
    };
    const accepted = await executeRepairAttempt({ model: model as never }, input);
    expect(accepted.fixedCode).toBe(mechanical);
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        // Replay the accepted generated body against healthy and mutated DOM.
        const body = accepted.fixedCode?.match(/async \(\{page\}\) => \{ ([\s\S]*) \}\);$/)?.[1];
        expect(body).toBeDefined();
        const replay = new Function("page", "expect", `return (async () => { ${body} })();`);
        const boundedExpect = playwrightExpect.configure({ timeout: 200 });
        await page.setContent('<output data-testid="total">$59.00</output>');
        await replay(page, boundedExpect);
        await page.setContent('<output data-testid="total">$49.00</output>');
        await expect(replay(page, boundedExpect)).rejects.toThrow();
        model.invoke.mockResolvedValue(new AIMessage(mechanical.replace("$59.00", "$49.00")));
        const rejected = await executeRepairAttempt(
            { model: model as never },
            { ...input, testDraft: mechanical },
        );
        expect(rejected.fixedCode).toBeUndefined();
        expect(rejected.summary).toContain("REPAIR REJECTED");
    } finally {
        await browser.close();
    }
});
