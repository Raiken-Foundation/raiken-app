import { describe, expect, it } from "vitest";
import { missingScenarioExpectations } from "../../cover/repair-setup";
import { assertedScenarioTokens, changedAssertionRequirements } from "../assertion-contract";

const wrap = (body: string) => `test('cart', async ({ page }) => { ${body} });`;
const check = `await expect(page.getByTestId('total')).toHaveText('$59.00');`;

describe("assertion contract adversarial replays", () => {
    it.each([
        ["expected value", check, check.replace("59", "49")],
        ["negation", check, check.replace(".toHaveText", ".not.toHaveText")],
        ["weaker matcher", check, check.replace("toHaveText", "toContainText")],
        ["deleted assertion", check, ""],
        ["swallowed rejection", check, check.replace(";", ".catch(() => {});")],
        ["early return", check, `return; ${check}`],
        ["uncalled helper", check, `const unused = async () => { ${check} };`],
        ["conditional", check, `if (false) { ${check} }`],
        ["catch block", check, `try { ${check} } catch {}`],
        ["unawaited assertion", check, check.replace("await ", "")],
        ["constant actual", check, `expect('$59.00').toHaveText('$59.00');`],
        [
            "constant binding",
            `const total = await page.textContent('#total'); expect(total).toBe('$59.00');`,
            `const total = '$59.00'; expect(total).toBe('$59.00');`,
        ],
        [
            "mutable actual",
            `let total = await page.textContent('#total'); expect(total).toBe('$59.00');`,
            `let total = await page.textContent('#total'); total = '$59.00'; expect(total).toBe('$59.00');`,
        ],
        [
            "expected binding",
            `const amount = 59; expect(total).toBe(amount);`,
            `const amount = 49; expect(total).toBe(amount);`,
        ],
        [
            "transitive binding",
            `const amount = 59; const settings = { price: amount }; expect(total).toBe(settings.price);`,
            `const amount = 49; const settings = { price: amount }; expect(total).toBe(settings.price);`,
        ],
        [
            "semantic option",
            `expect(box).toBeChecked({checked: true});`,
            `expect(box).toBeChecked({checked: false});`,
        ],
        [
            "case sensitivity",
            `expect(total).toHaveText('USD', {ignoreCase: false});`,
            `expect(total).toHaveText('USD', {ignoreCase: true});`,
        ],
        [
            "expected timeout property",
            `expect(response).toEqual({timeout: 59});`,
            `expect(response).toEqual({timeout: 49});`,
        ],
        ["duplicate removed", `${check} ${check}`, check],
    ])("rejects %s", (_name, before, after) => {
        expect(changedAssertionRequirements(wrap(before), wrap(after)).length).toBeGreaterThan(0);
    });
    it.each(["skip", "fixme", "only"])("rejects test.%s", (modifier) => {
        expect(
            changedAssertionRequirements(
                wrap(check),
                wrap(check).replace("test(", `test.${modifier}(`),
            ).length,
        ).toBeGreaterThan(0);
    });
    it.each([
        ["locator", check, check.replace("getByTestId('total')", "getByRole('status')")],
        ["timeout", check, check.replace("'$59.00')", "'$59.00', {timeout: 10000})")],
        ["formatting", check, check.replace("'$59.00'", '"$59.00"')],
    ])("allows mechanical %s repair", (_name, before, after) => {
        expect(changedAssertionRequirements(wrap(before), wrap(after))).toEqual([]);
    });
    it("resolves bindings in lexical scope", () => {
        const before = `const amount = 49; ${wrap("const amount = 59; expect(total).toBe(amount);")}`;
        expect(
            changedAssertionRequirements(before, before.replace("amount = 49", "amount = 39")),
        ).toEqual([]);
        expect(
            changedAssertionRequirements(before, before.replace("amount = 59", "amount = 39"))
                .length,
        ).toBeGreaterThan(0);
    });
    it("does not treat absence as evidence for a positive scenario", () => {
        const code = wrap(
            `await expect(page).toHaveURL('/'); await expect(page.getByText('$59.00')).not.toBeVisible();`,
        );
        expect(missingScenarioExpectations(code, "cart total is $59.00")).toContain("$59.00");
    });
    it("does not match expected numbers inside larger numbers", () => {
        expect(
            missingScenarioExpectations(wrap(`expect(total).toBe(159);`), "count is 59"),
        ).toContain("59");
    });
    it.each([
        `return; ${check}`,
        `const helper = async () => { ${check} };`,
        check.replace(";", ".catch(() => {});"),
    ])("does not use non-enforcing assertions as evidence", (body) => {
        expect(assertedScenarioTokens(wrap(body))).toEqual([]);
    });
});

it("allows locator repairs inside hooks", () => {
    const before = `test.beforeEach(async ({page}) => { await expect(page.getByTestId('old')).toBeVisible(); }); test('works', async () => {});`;
    expect(changedAssertionRequirements(before, before.replace("'old'", "'new'"))).toEqual([]);
});

it.each([
    `await expect(page.getByText('$59.00')).toHaveCount(0);`,
    `await expect(page.getByText('$59.00')).toBeVisible({visible: false});`,
    `await expect(page.getByTestId('$59.00')).toHaveText('$49.00');`,
])("requires the expected value to be the asserted outcome: %s", (body) => {
    expect(missingScenarioExpectations(wrap(body), "cart total is $59.00")).toContain("$59.00");
});
