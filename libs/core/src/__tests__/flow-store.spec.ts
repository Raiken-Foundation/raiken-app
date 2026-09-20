import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentMemory } from "../agent/memory";
import {
    loadRecordedCoverFlows,
    persistCoverFlows,
    recordLoginFlowFromEvidence,
    writeLoginScriptFromEvidence,
} from "../cover/flow-store";
import type { CoverFlow } from "../cover/flows";

describe("recorded flows + login script", () => {
    let projectDir: string;

    beforeEach(() => {
        projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-flow-store-"));
        fs.mkdirSync(path.join(projectDir, ".raiken"), { recursive: true });
    });

    afterEach(() => {
        AgentMemory.clearInstances();
        fs.rmSync(projectDir, { recursive: true, force: true });
    });

    it("persists and reloads cover flows", () => {
        const flows: CoverFlow[] = [
            {
                label: "Home → Cart → Checkout",
                steps: [
                    {
                        fromUrl: "http://app.local/",
                        toUrl: "http://app.local/cart",
                        selector: "getByRole('link', { name: 'Cart' })",
                        linkText: "Cart",
                    },
                    {
                        fromUrl: "http://app.local/cart",
                        toUrl: "http://app.local/checkout",
                        selector: "getByRole('link', { name: 'Checkout' })",
                        linkText: "Checkout",
                    },
                ],
                selectors: [
                    "getByRole('link', { name: 'Cart' })",
                    "getByRole('link', { name: 'Checkout' })",
                ],
            },
        ];
        expect(persistCoverFlows(projectDir, flows)).toBe(1);
        const loaded = loadRecordedCoverFlows(projectDir);
        expect(loaded[0]?.label).toBe("Home → Cart → Checkout");
        expect(loaded[0]?.steps).toHaveLength(2);
    });

    it("records a login flow and writes a reusable script", () => {
        AgentMemory.getInstance(projectDir).setPreference(
            "auth_login",
            JSON.stringify({
                url: "http://app.local/login",
                fields: [
                    { label: "Email", type: "email", selector: null },
                    { label: "Password", type: "password", selector: null },
                ],
                submit: "getByRole('button', { name: 'Sign in' })",
            }),
        );
        expect(recordLoginFlowFromEvidence(projectDir)).toBe(true);
        const flows = loadRecordedCoverFlows(projectDir);
        expect(flows.some((f) => f.label === "Login")).toBe(true);

        fs.writeFileSync(path.join(projectDir, "raiken.config.json"), "{}\n");
        const written = writeLoginScriptFromEvidence(projectDir);
        expect(written?.path).toContain(`${path.sep}.raiken${path.sep}login.ts`);
        expect(fs.existsSync(written?.path ?? "")).toBe(true);
        const script = fs.readFileSync(written?.path ?? "", "utf-8");
        expect(script).toContain("getByLabel");
        expect(script).toContain("credentials?.password");
        expect(written?.patchedConfig).toBe(true);
        const config = JSON.parse(
            fs.readFileSync(path.join(projectDir, "raiken.config.json"), "utf-8"),
        );
        expect(config.auth.customLoginScript).toBe(".raiken/login.ts");
    });
});
