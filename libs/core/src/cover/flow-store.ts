/**
 * Persist and reload first-class navigation / login flows for cover.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CodeGraphDB } from "../database/db";
import { SiteKnowledgeDB } from "../site-discovery/db";
import { type AuthLoginEvidence, readAuthLoginEvidence } from "./evidence";
import type { CoverFlow, CoverFlowStep } from "./flows";

function openSiteDb(projectPath: string): { codeDb: CodeGraphDB; siteDb: SiteKnowledgeDB } {
    const codeDb = new CodeGraphDB(projectPath);
    const siteDb = new SiteKnowledgeDB(codeDb.getRawDatabase(), projectPath);
    return { codeDb, siteDb };
}

function slugName(label: string): string {
    return (
        label
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 80) || "flow"
    );
}

/** Persist discovery-built flows into the recorded_flows table. */
export function persistCoverFlows(
    projectPath: string,
    flows: CoverFlow[],
    source = "discovery",
): number {
    if (flows.length === 0) return 0;
    const { codeDb, siteDb } = openSiteDb(projectPath);
    try {
        let saved = 0;
        for (const flow of flows) {
            siteDb.saveRecordedFlow({
                name: slugName(flow.label),
                label: flow.label,
                stepsJson: JSON.stringify(flow.steps),
                source,
            });
            saved += 1;
        }
        return saved;
    } finally {
        codeDb.close();
    }
}

/** Turn observed auth_login evidence into a named "login" flow. */
export function recordLoginFlowFromEvidence(
    projectPath: string,
    evidence: AuthLoginEvidence | null = readAuthLoginEvidence(projectPath),
): boolean {
    if (!evidence?.url || evidence.fields.length === 0) return false;
    const steps: CoverFlowStep[] = evidence.fields.map((field) => ({
        fromUrl: evidence.url as string,
        toUrl: evidence.url as string,
        selector: field.selector ?? `getByLabel(${JSON.stringify(field.label)})`,
        linkText: field.label,
    }));
    if (evidence.submit) {
        steps.push({
            fromUrl: evidence.url,
            toUrl: evidence.url,
            selector: evidence.submit,
            linkText: "Submit",
        });
    }

    const { codeDb, siteDb } = openSiteDb(projectPath);
    try {
        siteDb.saveRecordedFlow({
            name: "login",
            label: "Login",
            stepsJson: JSON.stringify(steps),
            source: "auth",
        });
        return true;
    } finally {
        codeDb.close();
    }
}

/** Load recorded flows as CoverFlow objects (newest first). */
export function loadRecordedCoverFlows(projectPath: string): CoverFlow[] {
    try {
        const { codeDb, siteDb } = openSiteDb(projectPath);
        try {
            return siteDb.listRecordedFlows().map((row) => {
                let steps: CoverFlowStep[] = [];
                try {
                    steps = JSON.parse(row.stepsJson) as CoverFlowStep[];
                } catch {
                    steps = [];
                }
                return {
                    label: row.label,
                    steps,
                    selectors: steps.map((s) => s.selector).filter(Boolean),
                };
            });
        } finally {
            codeDb.close();
        }
    } catch {
        return [];
    }
}

/**
 * Generate a Playwright custom login module from observed login fields and
 * write it to `.raiken/login.ts`, optionally patching raiken.config.json.
 */
export function writeLoginScriptFromEvidence(
    projectPath: string,
    evidence: AuthLoginEvidence | null = readAuthLoginEvidence(projectPath),
): { path: string; patchedConfig: boolean } | null {
    if (!evidence?.fields.length) return null;

    const dir = path.join(projectPath, ".raiken");
    fs.mkdirSync(dir, { recursive: true });
    const scriptPath = path.join(dir, "login.ts");

    const fills = evidence.fields
        .map((field) => {
            const selector = field.selector ?? `page.getByLabel(${JSON.stringify(field.label)})`;
            const valueExpr =
                field.type === "password"
                    ? "credentials?.password ?? ''"
                    : "credentials?.username ?? ''";
            const call = selector.startsWith("page.")
                ? `await ${selector}.fill(${valueExpr});`
                : `await page.locator(${JSON.stringify(selector)}).fill(${valueExpr});`;
            return `  ${call}`;
        })
        .join("\n");

    const submit = evidence.submit
        ? evidence.submit.startsWith("page.") || evidence.submit.startsWith("getBy")
            ? `  await ${evidence.submit.startsWith("page.") ? evidence.submit : `page.${evidence.submit}`}.click();`
            : `  await page.locator(${JSON.stringify(evidence.submit)}).click();`
        : `  await page.getByRole('button', { name: /sign in|log in|submit/i }).click();`;

    const body = `/**
 * Auto-generated by Raiken from an observed login form.
 * Used by \`raiken auth --script .raiken/login.ts\`.
 */
import type { BrowserContext, Page } from "@playwright/test";

export default async function login(args: {
  page: Page;
  context: BrowserContext;
  credentials?: { username?: string; password?: string };
}): Promise<void> {
  const { page, credentials } = args;
${evidence.url ? `  await page.goto(${JSON.stringify(evidence.url)}, { waitUntil: "domcontentloaded" });\n` : ""}${fills}
${submit}
}
`;

    fs.writeFileSync(scriptPath, body, "utf-8");

    let patchedConfig = false;
    const configPath = path.join(projectPath, "raiken.config.json");
    try {
        if (fs.existsSync(configPath)) {
            const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
                auth?: Record<string, unknown>;
            };
            raw.auth = { ...(raw.auth ?? {}), customLoginScript: ".raiken/login.ts" };
            fs.writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
            patchedConfig = true;
        }
    } catch {
        patchedConfig = false;
    }

    return { path: scriptPath, patchedConfig };
}
