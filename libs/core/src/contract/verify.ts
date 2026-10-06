import { chromium, type Page } from "playwright";
import { readFormControls } from "../browser/form-controls";
import type { BehaviorFact, FactEvidence } from "./types";

/**
 * The verifier: re-observe facts against the live app and produce verdicts.
 *
 * A fact is verified when its observable is present again; violated when it
 * was captured before but is absent now. "Absent now" is the only violation
 * signal v1 trusts — new copy for the same behavior is a different fact, and
 * that distinction is what keeps a real regression from hiding behind
 * "the text changed".
 *
 * Facts are replayed from their own description: `open <route>` navigates and
 * checks the structural observable; `submit "<label>" form empty` clicks the
 * submit and checks the resulting validation copy.
 */

export type VerdictKind = "verified" | "violated" | "unverified";

export interface FactVerdict {
    factKey: string;
    route: string;
    action: string;
    expectedObservable: string;
    verdict: VerdictKind;
    /** Human-readable what-was-checked line (business-language output). */
    detail: string;
    evidence?: FactEvidence;
}

export interface VerifyOptions {
    baseURL: string;
    facts: BehaviorFact[];
    storageStatePath?: string | null;
    headless?: boolean;
}

interface ObservableSpec {
    kind: "heading" | "text" | "inputs";
    text?: string;
    labels?: string[];
    /** Submit label minted into the fact (`… and submit [Add chore]`), now verified. */
    submitLabel?: string;
}

/** Parse a stored `expectedObservable` into a machine-checkable spec. */
export function parseObservable(expected: string): ObservableSpec | null {
    const heading = expected.match(/^shows heading "(.+)"$/);
    if (heading) return { kind: "heading", text: heading[1] };
    const text = expected.match(/^shows "(.+)"$/);
    if (text) return { kind: "text", text: text[1] };
    const inputs = expected.match(/^exposes inputs \[([^\]]+)\](?: and submit \[([^\]]+)\])?$/);
    if (inputs) {
        return {
            kind: "inputs",
            labels: inputs[1].split(", ").map((l) => l.trim()),
            submitLabel: inputs[2],
        };
    }
    return null;
}

/** Parse a stored `action` into replay steps. */
export function parseAction(action: string): { kind: "open" } | { kind: "submit-empty"; label: string } {
    const submit = action.match(/^submit "(.+)" form empty$/);
    if (submit) return { kind: "submit-empty", label: submit[1] };
    return { kind: "open" };
}

/** Turn a stored route (URL or path) into a goto-able URL under baseURL. */
export function resolveFactUrl(route: string, baseURL: string): string {
    if (/^https?:\/\//i.test(route)) return route;
    const base = baseURL.replace(/\/$/, "");
    return base + (route.startsWith("/") ? route : `/${route}`);
}

async function checkObservable(page: Page, spec: ObservableSpec): Promise<boolean> {
    if (spec.kind === "heading") {
        return page.evaluate((text) => {
            // Any heading level, plus `role="heading"` elements: the accessible
            // view of a page's headings, not the tag-name view.
            const headings = Array.from(
                document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]"),
            );
            return headings.some((h) => (h.textContent ?? "").trim() === text);
        }, spec.text);
    }
    if (spec.kind === "text") {
        return page.evaluate((text) => {
            return (document.body?.innerText ?? "").includes(text as string);
        }, spec.text);
    }
    // Form observables re-observe through the same accessible-name collector
    // discovery mints with (`browser/form-controls.ts`) — matching a raw
    // attribute haystack here is what made accessible `<label for>` markup
    // false-fail.
    const { fields, submits } = await readFormControls(page);
    const labelsOk = (spec.labels ?? []).every((label) =>
        fields.some((f) => f.label.toLowerCase().includes(label.toLowerCase())),
    );
    const submitLabel = spec.submitLabel?.toLowerCase();
    const submitOk =
        !submitLabel || submits.some((s) => s.toLowerCase().includes(submitLabel));
    return labelsOk && submitOk;
}

/** Re-observe one fact; never throws — failures become `unverified`. */
async function verifyOne(
    page: Page,
    baseURL: string,
    fact: BehaviorFact,
): Promise<FactVerdict> {
    const spec = parseObservable(fact.expectedObservable);
    const action = parseAction(fact.action);
    if (!spec) {
        return {
            factKey: fact.factKey,
            route: fact.route,
            action: fact.action,
            expectedObservable: fact.expectedObservable,
            verdict: "unverified",
            detail: "observable format not re-playable yet",
        };
    }

    try {
        await page.goto(resolveFactUrl(fact.route, baseURL), {
            waitUntil: "domcontentloaded",
            timeout: 15000,
        });
        await page.waitForTimeout(400);

        if (action.kind === "submit-empty") {
            const btn = page.getByRole("button", { name: new RegExp(`^${escapeRe(action.label)}$`, "i") }).first();
            await btn.click({ timeout: 4000 });
            await page.waitForTimeout(700);
        }

        const present = await checkObservable(page, spec);
        const afterText = await page
            .evaluate(() => document.body?.innerText?.slice(0, 600) ?? "")
            .catch(() => "");

        if (present) {
            return {
                factKey: fact.factKey,
                route: fact.route,
                action: fact.action,
                expectedObservable: fact.expectedObservable,
                verdict: "verified",
                detail: `observed ${fact.expectedObservable}`,
                evidence: {
                    source: "repair",
                    capturedAt: Date.now(),
                    observedUrl: page.url(),
                    afterText: afterText.slice(0, 300),
                },
            };
        }
        return {
            factKey: fact.factKey,
            route: fact.route,
            action: fact.action,
            expectedObservable: fact.expectedObservable,
            verdict: "violated",
            detail: `expected ${fact.expectedObservable} — no longer present`,
            evidence: {
                source: "repair",
                capturedAt: Date.now(),
                observedUrl: page.url(),
                afterText: afterText.slice(0, 300),
            },
        };
    } catch (error) {
        return {
            factKey: fact.factKey,
            route: fact.route,
            action: fact.action,
            expectedObservable: fact.expectedObservable,
            verdict: "unverified",
            detail: `could not re-observe: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

export async function verifyFacts(options: VerifyOptions): Promise<FactVerdict[]> {
    const { facts, baseURL, storageStatePath } = options;
    if (facts.length === 0) return [];

    const verdicts: FactVerdict[] = [];
    const browser = await chromium.launch({ headless: options.headless ?? true });
    try {
        for (const fact of facts) {
            const context = await browser.newContext(
                storageStatePath ? { storageState: storageStatePath } : {},
            );
            const page = await context.newPage();
            try {
                verdicts.push(await verifyOne(page, baseURL, fact));
            } finally {
                await context.close().catch(() => undefined);
            }
        }
    } finally {
        await browser.close().catch(() => undefined);
    }
    return verdicts;
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ==========================================================================
// Diff scoping
// ==========================================================================

/** Files whose change can affect behavior everywhere (root/layout/server). */
const GLOBAL_BASENAMES = new Set([
    "index.html",
    "server.js",
    "app.js",
    "app.ts",
    "main.js",
    "main.ts",
    "styles.css",
    "layout.tsx",
    "playwright.config.ts",
    "raiken.config.json",
    "package.json",
]);

/**
 * Scope facts to a changed-file set. v1 is deterministic and explainable:
 * a fact is in scope when a changed path shares a token with its route, or
 * when any changed file is global (layout/server/config). Projects with a
 * conventional static layout get precise scoping for free.
 */
export function scopeFactsByChanges(
    facts: BehaviorFact[],
    changedFiles: string[],
): { scoped: BehaviorFact[]; global: boolean } {
    // No change information (non-git project, clean tree) widens to the whole
    // contract — an empty scope here used to short-circuit verify into a
    // silent exit 0 on a broken app.
    if (changedFiles.length === 0) return { scoped: facts, global: true };

    const global = changedFiles.some((f) => {
        const base = f.split("/").pop() ?? f;
        return GLOBAL_BASENAMES.has(base) || /\.css$/i.test(base);
    });

    const tokens = new Set<string>();
    for (const file of changedFiles) {
        for (const part of file.replace(/[.#]/g, "/").split("/")) {
            const t = part.toLowerCase();
            // Extensions ("html", "tsx", "css") and short fragments match
            // everything and defeat scoping — they are structure, not identity.
            if (t.length > 2 && !/^[a-z0-9]{2,5}$/.test(t) && !/\.(html?|tsx?|jsx?|css|json|md|vue|svelte|mjs|cjs)$/i.test(t)) {
                tokens.add(t);
            }
        }
    }

    const scoped = facts.filter(
        (fact) => global || Array.from(tokens).some((t) => fact.route.toLowerCase().includes(t)),
    );
    return { scoped, global };
}
