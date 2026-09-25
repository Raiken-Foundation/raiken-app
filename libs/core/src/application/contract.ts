import * as fs from "node:fs";
import * as path from "node:path";
import { SqliteDbAdapter } from "../database/adapter";
import { CodeGraphDB } from "../database/db";
import {
    buildContractView,
    captureFormStates,
    computeContractChanges,
    type ContractChanges,
    computeCoverage,
    exploreUncovered,
    extractSourceRoutes,
    mergeKnownRoutes,
    recordApiCalls,
    snapshotRoutes,
    contractToJson,
    contractToMarkdown,
    diffContracts,
    importRequirements,
    materializeFacts,
    mintFromSiteKnowledge,
    parseRequirementsFile,
    parseTicketRequirements,
    extractRouteBindings,
    loadDependentsGraph,
    scopeFactsByChanges,
    scopeFactsByImpact,
    verifyFacts,
    type BehaviorFact,
    type CaptureResult,
    type CaptureRoute,
    type ContractDiff,
    type ContractView,
    type FactVerdict,
    type MaterializeResult,
} from "../contract";
import { ContractStore } from "../contract/store";
import { notFoundError } from "../errors";
import type { ResolvedAIConfig } from "../agent/ai-providers";
import type { ProjectApplicationContext } from "./context";

export interface ContractScope {
    /** graph: graft code graph + route map · names: file-name matching · all: --all */
    scoper: "graph" | "names" | "all";
    scoped: BehaviorFact[];
    reasons: Array<{ factKey: string; reason: string }>;
    globalReason: string | null;
    unmapped: string[];
}

/**
 * Contract application service — the two-sided behavior contract scoped to a
 * project. Owns: minting observed facts from site knowledge and live form
 * capture, importing intent from AC files and tickets, computing requirement
 * coverage, and exporting/diffing the readable artifact.
 */
export class ContractApplication implements ProjectApplicationContext {
    readonly projectPath: string;

    constructor(projectPath: string) {
        this.projectPath = projectPath;
    }

    private withStore<T>(fn: (store: ContractStore) => T): T {
        const db = new CodeGraphDB(this.projectPath);
        try {
            return fn(new ContractStore(new SqliteDbAdapter(db.getRawDatabase(), this.projectPath)));
        } finally {
            db.close();
        }
    }

    /**
     * Async-aware variant: the DB stays open until the awaited work settles —
     * a synchronous finally would close it under a running browser capture
     * and silently swallow every mint (found the hard way).
     */
    private async withStoreAsync<T>(fn: (store: ContractStore) => T | Promise<T>): Promise<T> {
        const db = new CodeGraphDB(this.projectPath);
        try {
            return await fn(new ContractStore(new SqliteDbAdapter(db.getRawDatabase(), this.projectPath)));
        } finally {
            db.close();
        }
    }

    /** Mint observed facts from existing discovery knowledge (no browser). */
    mintFromDiscovery(): { minted: number; refreshed: number; total: number } {
        const db = new CodeGraphDB(this.projectPath);
        try {
            const result = mintFromSiteKnowledge(db.getRawDatabase(), this.projectPath);
            return { minted: result.minted, refreshed: result.refreshed, total: result.facts.length };
        } finally {
            db.close();
        }
    }

    /**
     * Live form-state capture: empty-submit probing over discovered forms.
     * The app must be running; routes come from site knowledge.
     */
    async capture(options: { storageStatePath?: string | null } = {}): Promise<CaptureResult> {
        const routes = this.captureRoutesFromKnowledge();
        return this.withStoreAsync((store) =>
            captureFormStates({
                routes,
                storageStatePath: options.storageStatePath ?? null,
                store,
            }),
        );
    }

    /** Form-bearing discovered pages as capture targets. */
    captureRoutesFromKnowledge(): CaptureRoute[] {
        const db = new CodeGraphDB(this.projectPath);
        try {
            const rows = db
                .getRawDatabase()
                .prepare(
                    `SELECT url, normalized_url, forms_json, captured_authenticated
                     FROM discovered_pages WHERE project_path = ? AND forms_json IS NOT NULL`,
                )
                .all(this.projectPath) as Array<{
                url: string;
                normalized_url: string;
                forms_json: string | null;
                captured_authenticated: number;
            }>;
            const out: CaptureRoute[] = [];
            for (const row of rows) {
                try {
                    const forms = JSON.parse(row.forms_json ?? "{}") as {
                        fields?: Array<{ label?: string; type?: string }>;
                        submits?: string[];
                    };
                    if (!forms.fields?.length) continue;
                    out.push({
                        route: row.normalized_url,
                        url: row.url,
                        fields: forms.fields,
                        submits: forms.submits ?? [],
                        authenticated: row.captured_authenticated === 1,
                    });
                } catch {
                    // malformed forms_json — skip the page
                }
            }
            return out;
        } finally {
            db.close();
        }
    }

    /** Import intent requirements from a markdown/text file (or raw text). */
    importFromFile(input: { filePath?: string; text?: string }): {
        imported: number;
        skipped: number;
        requirements: number;
    } {
        let raw: string;
        if (input.filePath) {
            const resolved = path.isAbsolute(input.filePath)
                ? input.filePath
                : path.join(this.projectPath, input.filePath);
            if (!fs.existsSync(resolved)) {
                throw notFoundError(`Requirements file not found: ${input.filePath}`, {
                    code: "FILE_NOT_FOUND",
                });
            }
            raw = fs.readFileSync(resolved, "utf-8");
        } else if (input.text) {
            raw = input.text;
        } else {
            throw notFoundError("Provide --file <path> or --text <requirements>", {
                code: "FILE_NOT_FOUND",
            });
        }
        const parsed = parseRequirementsFile(raw);
        const result = this.withStore((store) => importRequirements(store, "file", parsed));
        return { imported: result.imported, skipped: result.skipped, requirements: parsed.length };
    }

    /** Import intent requirements extracted from a fetched ticket. */
    importFromTicket(ticket: {
        id: string;
        provider: string;
        title: string;
        body: string;
        severity?: string | null;
        url?: string | null;
    }): { imported: number; skipped: number; requirements: number } {
        const parsed = parseTicketRequirements(ticket.title, ticket.body);
        const result = this.withStore((store) =>
            importRequirements(store, "ticket", parsed, {
                id: ticket.id,
                provider: ticket.provider,
                severity: ticket.severity ?? null,
                url: ticket.url ?? null,
            }),
        );
        return { imported: result.imported, skipped: result.skipped, requirements: parsed.length };
    }

    /** Compute and persist requirement coverage. */
    coverage(): ReturnType<typeof computeCoverage> {
        return this.withStore((store) => computeCoverage(store));
    }

    /** Token search across both sides of the contract. */
    searchContract(query: string): {
        facts: import("../contract/types").BehaviorFact[];
        intents: import("../contract/types").IntentFact[];
    } {
        return this.withStore((store) => store.searchContract(query));
    }

    /** Pending behavior-change reviews (violated facts awaiting a decision). */
    listReviews(status?: "pending" | "accepted" | "rejected"): Array<import("../contract/types").FactReview> {
        return this.withStore((store) => store.listReviews(status));
    }

    /** Accept retires the old fact (change was intentional); reject keeps the
     *  violation standing (it's a regression). */
    resolveReview(reviewId: number, accept: boolean): boolean {
        return this.withStore((store) => store.resolveReview(reviewId, accept));
    }

    /** Remove a junk/duplicate fact (see store.forgetFact). */
    forgetFact(factKey: string): { forgotten: boolean; reason?: string } {
        return this.withStore((store) => store.forgetFact(factKey));
    }

    /** Undo an accepted review — the retired fact returns as unverified. */
    restoreReview(reviewId: number): boolean {
        return this.withStore((store) => store.restoreReview(reviewId));
    }

    /** Evidence ledger: recent fact events (mint/verify/violate timeline). */
    factHistory(factKey?: string): Array<import("../contract/types").FactEvent> {
        return this.withStore((store) => store.listFactEvents(factKey));
    }

    /**
     * Behavior changes between commits: ledger events stamped with a commit
     * in `range` (git syntax, e.g. `origin/main..HEAD`), grouped per commit.
     */
    changes(range: string): ContractChanges {
        return this.withStore((store) => computeContractChanges(store, this.projectPath, range));
    }

    /** Full contract view (observed + intent + coverage). */
    view(): ContractView {
        return this.withStore((store) => buildContractView(store, this.projectPath));
    }

    /** Write contract.md + contract.json export files; returns their paths. */
    export(outputDir?: string): { markdownPath: string; jsonPath: string } {
        const dir = outputDir ?? path.join(this.projectPath, ".raiken");
        fs.mkdirSync(dir, { recursive: true });
        const view = this.view();
        const markdownPath = path.join(dir, "contract.md");
        const jsonPath = path.join(dir, "contract.json");
        fs.writeFileSync(markdownPath, contractToMarkdown(view), "utf-8");
        fs.writeFileSync(jsonPath, contractToJson(view), "utf-8");
        return { markdownPath, jsonPath };
    }

    /** Where the app lives, best-effort: explicit arg > playwright config >
     *  the origin the facts were actually observed at. The last fallback is
     *  what makes verify work on projects with no playwright.config.ts. */
    private discoveredBaseURLFallback(): string | null {
        const first = this.withStore((store) => store.listBehaviorFacts()[0]);
        if (!first) return null;
        try {
            const u = new URL(first.route);
            return `${u.protocol}//${u.host}`;
        } catch {
            return null;
        }
    }

    /**
     * Verify facts against the live app. When `changedFiles` is provided,
     * only facts scoped to the change set are re-observed; `verifyAll` forces
     * the full contract. Verdicts are persisted (status/counters), and
     * matched intent facts follow their fact into `violated` when it breaks.
     */
    async verify(input: {
        baseURL?: string | null;
        changedFiles?: string[];
        verifyAll?: boolean;
        storageStatePath?: string | null;
    }): Promise<{ verdicts: FactVerdict[]; scoped: number; total: number; scope: ContractScope }> {
        const { readPlaywrightBaseURL } = await import("../testing/playwright-config");
        const baseURL =
            input.baseURL ??
            (await readPlaywrightBaseURL(this.projectPath)) ??
            this.discoveredBaseURLFallback();
        if (!baseURL) {
            throw notFoundError("No baseURL — set one in playwright.config.ts or pass --base-url.");
        }
        // Re-observe verified AND violated facts — a violated fact must be
        // able to return to verified when the app is fixed, not vanish from
        // the check set the moment it fails.
        const allFacts = this.withStore((store) => store.listBehaviorFacts());
        const scope = input.verifyAll
            ? { scoper: "all" as const, scoped: allFacts, reasons: [], globalReason: "--all", unmapped: [] }
            : await this.scope(allFacts, input.changedFiles ?? []);
        if (scope.scoped.length === 0) {
            return { verdicts: [], scoped: 0, total: allFacts.length, scope };
        }
        const verdicts = await verifyFacts({
            baseURL,
            facts: scope.scoped,
            storageStatePath: input.storageStatePath ?? null,
        });
        // Persist verdicts and cascade violated status to matched intents.
        this.withStore((store) => {
            for (const verdict of verdicts) {
                if (verdict.verdict === "unverified") continue;
                const fact = store.getBehaviorFactByKey(verdict.factKey);
                if (!fact?.id) continue;
                store.setBehaviorStatus(
                    fact.id,
                    verdict.verdict === "verified" ? "verified" : "violated",
                );
                // Cascade to matched intents in BOTH directions: a violated
                // fact takes its requirements down; a re-verified fact brings
                // them back to covered.
                const intents = store.listIntentFacts().filter((i) => i.matchedFactId === fact.id);
                if (verdict.verdict === "violated") {
                    // A violated fact is also a *behavior change* someone must
                    // adjudicate: accept it into the contract, or reject it as
                    // a regression. Queue the decision (one pending per fact).
                    store.insertReview(verdict, verdict.detail);
                    for (const intent of intents) {
                        store.setIntentCoverage(intent.id!, "violated", fact.id);
                    }
                } else if (verdict.verdict === "verified") {
                    for (const intent of intents) {
                        if (intent.status === "violated") {
                            store.setIntentCoverage(intent.id!, "covered", fact.id);
                        }
                    }
                }
            }
        });
        return { verdicts, scoped: scope.scoped.length, total: allFacts.length, scope };
    }

    /**
     * Which facts can this change reach? With a graft code graph the answer
     * is structural (changed file → dependents → route component → facts) and
     * each fact carries the path that put it in scope; without one, fall back
     * to matching changed-file names against routes.
     */
    async scope(facts: BehaviorFact[], changedFiles: string[]): Promise<ContractScope> {
        const graph = await loadDependentsGraph(this.projectPath);
        if (graph) {
            const bindings = extractRouteBindings(this.projectPath);
            if (bindings.length > 0) {
                const impact = scopeFactsByImpact({
                    projectPath: this.projectPath,
                    facts,
                    changedFiles,
                    bindings,
                    graph,
                });
                return {
                    scoper: "graph",
                    scoped: impact.scoped,
                    reasons: impact.scoped.map((f) => ({
                        factKey: f.factKey,
                        reason: impact.reasons.get(f.factKey) ?? "",
                    })),
                    globalReason: impact.globalReason,
                    unmapped: impact.unmapped,
                };
            }
        }
        const byName = scopeFactsByChanges(facts, changedFiles);
        return {
            scoper: "names",
            scoped: byName.scoped,
            reasons: [],
            globalReason: byName.global ? "a global file changed" : null,
            unmapped: [],
        };
    }

    /** Business-language violation lines: fact + ticket/AC provenance. */
    violationsReport(verdicts: FactVerdict[]): Array<{ line: string; factKey: string }> {
        return this.withStore((store) => {
            const intents = store.listIntentFacts();
            return verdicts
                .filter((v) => v.verdict === "violated")
                .map((v) => {
                    const fact = store.getBehaviorFactByKey(v.factKey);
                    const intent = intents.find((i) => i.matchedFactId === fact?.id);
                    const citation = intent
                        ? ` — violates ${intent.ticketId ? `#${intent.ticketId} ` : ""}AC: "${intent.requirementText}"`
                        : "";
                    return {
                        factKey: v.factKey,
                        line: `${v.route}: ${v.detail}${citation}`,
                    };
                });
        });
    }

    /** Materialize disposable Playwright specs from selected facts. */
    materialize(input: {
        outDir: string;
        baseURL?: string | null;
        storageStatePath?: string | null;
    }): MaterializeResult {
        const facts = this.withStore((store) => store.listBehaviorFacts("verified"));
        const baseURL = input.baseURL ?? "";
        // Replay recorded GETs when present so read-dependent facts are
        // hermetic against a reset backend.
        let mocks: import("../contract/record").RecordedMock[] | undefined;
        const recordPath = path.join(this.projectPath, ".raiken", "recorded-api.json");
        if (fs.existsSync(recordPath)) {
            try {
                mocks = JSON.parse(fs.readFileSync(recordPath, "utf-8"));
            } catch {
                // stale/unreadable record — materialize unmocked
            }
        }
        return materializeFacts({
            baseURL,
            facts,
            outDir: input.outDir,
            storageStatePath: input.storageStatePath ?? null,
            mocks,
        });
    }

    /** Record GET API traffic across known routes for hermetic materialization. */
    async record(input: {
        baseURL?: string | null;
        storageStatePath?: string | null;
    }): Promise<{ recorded: number; filePath: string }> {
        const { readPlaywrightBaseURL } = await import("../testing/playwright-config");
        const baseURL = input.baseURL ?? (await readPlaywrightBaseURL(this.projectPath)) ?? this.discoveredBaseURLFallback();
        if (!baseURL) {
            throw notFoundError("No baseURL — set one in playwright.config.ts or pass --base-url.");
        }
        const db = new CodeGraphDB(this.projectPath);
        let discoveredUrls: string[] = [];
        try {
            discoveredUrls = (
                db.getRawDatabase()
                    .prepare(`SELECT url FROM discovered_pages WHERE project_path = ?`)
                    .all(this.projectPath) as Array<{ url: string }>
            ).map((r) => r.url);
        } finally {
            db.close();
        }
        const routes = mergeKnownRoutes([], discoveredUrls, baseURL).map((r) => ({
            path: r.path,
            url: r.path.startsWith("http") ? r.path : baseURL + r.path,
        }));
        return recordApiCalls({
            baseURL,
            routes,
            storageStatePath: input.storageStatePath ?? null,
            outputPath: path.join(this.projectPath, ".raiken", "recorded-api.json"),
        });
    }

    /** Extract the route table from source (Next.js app-dir, React Router). */
    sourceRoutes(): ReturnType<typeof extractSourceRoutes> {
        return extractSourceRoutes(this.projectPath);
    }

    /**
     * Route-checklist snapshot: visit every known route (source-extracted +
     * already-discovered) and capture snapshots/forms into site knowledge.
     */
    async snapshotRoutes(input: {
        baseURL?: string | null;
        storageStatePath?: string | null;
    }): Promise<{ captured: string[]; failed: Array<{ route: string; reason: string }>; total: number; coverage: number; sources: number }> {
        const { readPlaywrightBaseURL } = await import("../testing/playwright-config");
        const baseURL = input.baseURL ?? (await readPlaywrightBaseURL(this.projectPath)) ?? this.discoveredBaseURLFallback();
        if (!baseURL) {
            throw notFoundError("No baseURL — set one in playwright.config.ts or pass --base-url.");
        }
        const sourceRoutes = extractSourceRoutes(this.projectPath);
        const db = new CodeGraphDB(this.projectPath);
        let discoveredUrls: string[] = [];
        try {
            discoveredUrls = (
                db.getRawDatabase()
                    .prepare(`SELECT url FROM discovered_pages WHERE project_path = ?`)
                    .all(this.projectPath) as Array<{ url: string }>
            ).map((r) => r.url);
        } finally {
            db.close();
        }
        const routes = mergeKnownRoutes(sourceRoutes, discoveredUrls, baseURL);
        const result = await snapshotRoutes({
            baseURL,
            routes,
            storageStatePath: input.storageStatePath ?? null,
            savePage: (page) => {
                const db2 = new CodeGraphDB(this.projectPath);
                try {
                    db2.getRawDatabase()
                        .prepare(
                            `INSERT OR REPLACE INTO discovered_pages
                             (project_path, url, normalized_url, title, snapshot_json, forms_json,
                              parent_url, navigation_action, depth, discovered_at, last_visited_at,
                              visit_count, captured_authenticated)
                             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 1, ?)`,
                        )
                        .run(
                            this.projectPath,
                            page.url,
                            page.normalizedUrl,
                            page.title,
                            page.snapshotJson,
                            page.formsJson,
                            page.depth,
                            Date.now(),
                            Date.now(),
                            page.capturedAuthenticated ? 1 : 0,
                        );
                } finally {
                    db2.close();
                }
            },
        });
        return { ...result, sources: sourceRoutes.length };
    }

    /**
     * Intent-driven exploration: hunt the uncovered-requirements queue,
     * execute LLM-planned action sequences under the destructive blocklist,
     * and mint matching facts. Returns outcomes + refreshed coverage.
     */
    async explore(input: {
        ai: ResolvedAIConfig;
        baseURL?: string | null;
        storageStatePath?: string | null;
    }): Promise<{
        outcomes: ReturnType<typeof exploreUncovered> extends Promise<infer T> ? T : never;
        coverage: ReturnType<typeof computeCoverage>;
    }> {
        const { readPlaywrightBaseURL } = await import("../testing/playwright-config");
        const baseURL = input.baseURL ?? (await readPlaywrightBaseURL(this.projectPath)) ?? this.discoveredBaseURLFallback();
        if (!baseURL) {
            throw notFoundError("No baseURL — set one in playwright.config.ts or pass --base-url.");
        }
        const db = new CodeGraphDB(this.projectPath);
        try {
            const store = new ContractStore(new SqliteDbAdapter(db.getRawDatabase(), this.projectPath));
            const intents = store.listIntentFacts();
            const observed = store.listBehaviorFacts();
            const routes = mergeKnownRoutes(
                extractSourceRoutes(this.projectPath),
                (
                    db.getRawDatabase()
                        .prepare(`SELECT url FROM discovered_pages WHERE project_path = ?`)
                        .all(this.projectPath) as Array<{ url: string }>
                ).map((r) => r.url),
                baseURL,
            ).map((r) => ({ path: r.path, url: r.path.startsWith("http") ? r.path : baseURL + r.path }));
            const formsByRoute = new Map<string, { fields: Array<{ label?: string }>; submits: string[] }>();
            for (const row of db.getRawDatabase()
                .prepare(`SELECT normalized_url, forms_json FROM discovered_pages WHERE project_path = ? AND forms_json IS NOT NULL`)
                .all(this.projectPath) as Array<{ normalized_url: string; forms_json: string }>) {
                try {
                    formsByRoute.set(row.normalized_url, JSON.parse(row.forms_json));
                } catch {
                    // malformed — skip
                }
            }
            const outcomes = await exploreUncovered({
                baseURL,
                intents,
                observed,
                routes,
                formsByRoute,
                ai: input.ai,
                store,
                storageStatePath: input.storageStatePath ?? null,
            });
            const coverage = computeCoverage(store);
            return { outcomes, coverage };
        } finally {
            db.close();
        }
    }

    /** Diff the current contract against the last export on disk. */
    diff(): ContractDiff & { hasBaseline: boolean } {
        const baselinePath = path.join(this.projectPath, ".raiken", "contract.json");
        if (!fs.existsSync(baselinePath)) {
            const empty: ContractView = {
                projectPath: this.projectPath,
                observed: [],
                intent: [],
                coverage: null,
                exportedAt: 0,
            };
            const diff = diffContracts(empty, this.view());
            return { ...diff, hasBaseline: false };
        }
        try {
            const before = JSON.parse(fs.readFileSync(baselinePath, "utf-8")) as ContractView;
            return { ...diffContracts(before, this.view()), hasBaseline: true };
        } catch {
            const empty: ContractView = {
                projectPath: this.projectPath,
                observed: [],
                intent: [],
                coverage: null,
                exportedAt: 0,
            };
            return { ...diffContracts(empty, this.view()), hasBaseline: false };
        }
    }
}
