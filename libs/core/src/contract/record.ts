import * as fs from "node:fs";
import * as path from "node:path";
import { chromium } from "playwright";

/**
 * API-call recording for hermetic materialization.
 *
 * Reads during a route pass get recorded; the materializer replays them as
 * `page.route()` mocks so read-dependent facts (lists, stats, catalogs) pass
 * even against a reset backend. Writes (POST/DELETE) are deliberately NOT
 * mocked — mocking an order submission would fabricate the confirmation the
 * test is supposed to prove.
 */

export interface RecordedMock {
    method: string;
    /** URL path pattern (query-less), e.g. `/api/notes`. */
    pathPattern: string;
    status: number;
    contentType: string;
    body: string;
}

export interface RecordResult {
    recorded: number;
    filePath: string;
}

export async function recordApiCalls(options: {
    baseURL: string;
    routes: Array<{ path: string; url: string }>;
    storageStatePath?: string | null;
    outputPath: string;
    headless?: boolean;
}): Promise<RecordResult> {
    const mocks: RecordedMock[] = [];
    const seen = new Set<string>();
    const browser = await chromium.launch({ headless: options.headless ?? true });
    try {
        for (const route of options.routes) {
            const context = await browser.newContext(
                options.storageStatePath ? { storageState: options.storageStatePath } : {},
            );
            const page = await context.newPage();
            page.on("response", async (response) => {
                const url = response.url();
                if (!/\/api\//i.test(url)) return;
                if (!["GET"].includes(response.request().method())) return;
                try {
                    const parsed = new URL(url);
                    const key = `${parsed.pathname}`;
                    if (seen.has(key)) return;
                    seen.add(key);
                    const body = await response.text().catch(() => "");
                    if (!body) return;
                    mocks.push({
                        method: "GET",
                        pathPattern: parsed.pathname,
                        status: response.status(),
                        contentType:
                            response.headers()["content-type"] ?? "application/json",
                        body,
                    });
                } catch {
                    // best-effort per response
                }
            });
            try {
                await page.goto(route.url, { waitUntil: "networkidle", timeout: 15000 });
                await page.waitForTimeout(500);
            } catch {
                // route unreachable — skip
            } finally {
                await context.close().catch(() => undefined);
            }
        }
    } finally {
        await browser.close().catch(() => undefined);
    }
    fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
    fs.writeFileSync(options.outputPath, JSON.stringify(mocks, null, 2), "utf-8");
    return { recorded: mocks.length, filePath: options.outputPath };
}

/** Render the page.route() mocking block for a set of recorded GETs. */
export function renderRouteMocks(mocks: RecordedMock[], indent = "  "): string {
    if (mocks.length === 0) return "";
    const lines: string[] = [];
    for (const mock of mocks) {
        lines.push(
            `${indent}await page.route(${JSON.stringify(`**${mock.pathPattern}**`)}, (route) =>`,
            // Only GETs replay — writes must hit the live app, otherwise the
            // mock would swallow exactly the validation errors a submit-empty
            // fact exists to prove.
            `${indent}  route.request().method() === "GET"`,
            `${indent}    ? route.fulfill({`,
            `${indent}        status: ${mock.status},`,
            `${indent}        contentType: ${JSON.stringify(mock.contentType)},`,
            `${indent}        body: ${JSON.stringify(mock.body)},`,
            `${indent}      })`,
            `${indent}    : route.continue(),`,
            `${indent});`,
        );
    }
    return lines.join("\n");
}
