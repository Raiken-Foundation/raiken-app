import { chromium, type Page } from "playwright";
import { mintObservedFact } from "./mint";
import { ContractStore } from "./store";
import type { FactEvidence } from "./types";

/**
 * Form-state capture: for each page in site knowledge that has a form, submit
 * it once with nothing filled and record the validation response as an
 * observed fact. This is what turns "invalid email shows an error" from an
 * unverified guess into grounded evidence — the validation copy is read off
 * the live app, never guessed.
 *
 * Guards: values are never stored (empty-submit only), the page state after
 * probing is discarded (fresh page per route), and destructive-looking
 * submits are skipped via the blocklist.
 */

const DESTRUCTIVE_SUBMIT = /delete|remove|archive|sign out|logout|clear|reset|confirm|unsubscribe|place order|pay/i;

export interface CaptureResult {
    pagesProbed: number;
    factsMinted: number;
    factsRefreshed: number;
    details: Array<{ route: string; action: string; observable: string }>;
}

export interface CaptureRoute {
    route: string;
    url: string;
    fields: Array<{ label?: string; type?: string }>;
    submits: string[];
    authenticated: boolean;
}

export async function captureFormStates(options: {
    routes: CaptureRoute[];
    storageStatePath?: string | null;
    store: ContractStore;
    headless?: boolean;
}): Promise<CaptureResult> {
    const { routes, storageStatePath, store } = options;
    const result: CaptureResult = { pagesProbed: 0, factsMinted: 0, factsRefreshed: 0, details: [] };
    const probeable = routes.filter((r) => hasInput(r.fields) && hasSafeSubmit(r.submits));
    if (probeable.length === 0) return result;

    const browser = await chromium.launch({ headless: options.headless ?? true });
    try {
        for (const route of probeable) {
            result.pagesProbed++;
            const context = await browser.newContext(
                storageStatePath ? { storageState: storageStatePath } : {},
            );
            const page = await context.newPage();
            try {
                await page.goto(route.url, { waitUntil: "domcontentloaded", timeout: 15000 });
                await page.waitForTimeout(400);
                const beforeText = await bodyText(page);

                const clicked = await clickFirstSubmit(page, route.submits);
                if (!clicked) continue;
                await page.waitForTimeout(700);
                const afterText = await bodyText(page);

                const observable = diffObservable(beforeText, afterText);
                if (!observable) continue;

                const evidence: FactEvidence = {
                    source: "capture",
                    capturedAt: Date.now(),
                    observedUrl: route.url,
                    beforeText: beforeText.slice(0, 300),
                    afterText: afterText.slice(0, 300),
                };
                const action = `submit "${route.submits.find(isSafeSubmit) ?? "page"}" form empty`;
                const minted = mintObservedFact(store, {
                    route: route.route,
                    precondition: route.authenticated ? "signed in" : null,
                    action,
                    expectedObservable: `shows "${observable}"`,
                    evidence,
                });
                minted.isNew ? result.factsMinted++ : result.factsRefreshed++;
                result.details.push({
                    route: route.route,
                    action,
                    observable: `shows "${observable}"`,
                });
            } catch {
                // Navigation/interaction failure on one route never aborts the sweep.
            } finally {
                await context.close().catch(() => undefined);
            }
        }
    } finally {
        await browser.close().catch(() => undefined);
    }
    return result;
}

function hasInput(fields: Array<{ label?: string; type?: string }>): boolean {
    return fields.some((f) => !f.type || ["text", "email", "password", "search", "number", "tel", "url"].includes(f.type));
}

function isSafeSubmit(label: string): boolean {
    return !DESTRUCTIVE_SUBMIT.test(label);
}

function hasSafeSubmit(submits: string[]): boolean {
    return submits.some(isSafeSubmit);
}

async function bodyText(page: Page): Promise<string> {
    return page
        .evaluate(() => document.body?.innerText?.slice(0, 900) ?? "")
        .catch(() => "");
}

async function clickFirstSubmit(page: Page, submits: string[]): Promise<boolean> {
    for (const label of submits.filter(isSafeSubmit)) {
        const btn = page.getByRole("button", { name: new RegExp(`^${escapeRe(label)}$`, "i") }).first();
        try {
            await btn.click({ timeout: 3000 });
            return true;
        } catch {
            // try next
        }
    }
    for (const sel of ['button[type="submit"]', "form button"]) {
        const btn = page.locator(sel).first();
        try {
            if ((await btn.count()) > 0) {
                await btn.click({ timeout: 3000 });
                return true;
            }
        } catch {
            // try next
        }
    }
    return false;
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** First meaningful line present in `after` but not in `before` — the change. */
export function diffObservable(before: string, after: string): string | null {
    const beforeLines = new Set(
        before
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean),
    );
    const added = after
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .filter((l) => !beforeLines.has(l) && l.length > 3 && l.length < 160);
    return added[0] ?? null;
}
