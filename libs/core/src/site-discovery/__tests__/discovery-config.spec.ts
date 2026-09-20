import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, loadDiscoveryConfig, writeConfigAtomicSync } from "../../config";
import { resolveSiteDiscoveryOptions } from "../discovery-config";

const temporaryDirectories: string[] = [];

async function makeProject(config: Record<string, unknown> = {}): Promise<string> {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-discovery-config-"));
    temporaryDirectories.push(projectPath);
    if (Object.keys(config).length > 0) {
        writeConfigAtomicSync(projectPath, config);
    }
    return projectPath;
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true })));
});

describe("loadDiscoveryConfig fixture matrix", () => {
    const productionFixtures: Array<{
        name: string;
        config: Record<string, unknown>;
        expected: Partial<ReturnType<typeof loadDiscoveryConfig>>;
    }> = [
        {
            name: "typical production crawl limits",
            config: {
                discovery: {
                    maxPages: 200,
                    maxDepth: 4,
                    maxConcurrency: 2,
                    timeout: 45_000,
                    excludePatterns: ["/api/**", "/static/**"],
                    pauseOnAuth: true,
                    maxRunTimeMs: 1_800_000,
                    preserveQueryParams: false,
                },
            },
            expected: {
                maxPages: 200,
                maxDepth: 4,
                maxConcurrency: 2,
                timeout: 45_000,
                excludePatterns: ["/api/**", "/static/**"],
                pauseOnAuth: true,
                maxRunTimeMs: 1_800_000,
                preserveQueryParams: false,
            },
        },
        {
            name: "SPA with query-param routes",
            config: {
                discovery: {
                    preserveQueryParams: true,
                    maxRunTimeMs: 0,
                    pauseOnAuth: false,
                },
            },
            expected: {
                preserveQueryParams: true,
                maxRunTimeMs: 0,
                pauseOnAuth: false,
                maxPages: defaultConfig.discovery.maxPages,
            },
        },
        {
            name: "mixed valid and malformed fields",
            config: {
                discovery: {
                    maxPages: "200",
                    maxDepth: 3,
                    timeout: -5,
                    excludePatterns: "not-an-array",
                    pauseOnAuth: "yes",
                    maxRunTimeMs: 900_000,
                },
            },
            expected: {
                maxPages: defaultConfig.discovery.maxPages,
                maxDepth: 3,
                timeout: defaultConfig.discovery.timeout,
                excludePatterns: defaultConfig.discovery.excludePatterns,
                pauseOnAuth: defaultConfig.discovery.pauseOnAuth,
                maxRunTimeMs: 900_000,
            },
        },
    ];

    for (const fixture of productionFixtures) {
        it(`resolves ${fixture.name}`, async () => {
            const projectPath = await makeProject(fixture.config);
            expect(loadDiscoveryConfig(projectPath)).toMatchObject(fixture.expected);
        });
    }
});

describe("loadDiscoveryConfig", () => {
    it("uses canonical schema defaults when config is missing", async () => {
        const projectPath = await makeProject();
        expect(loadDiscoveryConfig(projectPath)).toEqual(defaultConfig.discovery);
    });

    it("merges valid discovery fields from raiken.config.json", async () => {
        const projectPath = await makeProject({
            discovery: {
                maxPages: 42,
                preserveQueryParams: true,
                excludePatterns: ["/admin/**"],
            },
        });
        expect(loadDiscoveryConfig(projectPath)).toMatchObject({
            maxPages: 42,
            preserveQueryParams: true,
            excludePatterns: ["/admin/**"],
            maxDepth: defaultConfig.discovery.maxDepth,
        });
    });

    it("preserves valid discovery when an unrelated section is invalid", async () => {
        const projectPath = await makeProject({
            ai: { maxTokens: "not-a-number" },
            discovery: {
                maxPages: 42,
                preserveQueryParams: true,
            },
        });
        expect(loadDiscoveryConfig(projectPath)).toMatchObject({
            maxPages: 42,
            preserveQueryParams: true,
            maxDepth: defaultConfig.discovery.maxDepth,
        });
    });

    it("preserves valid discovery fields when another discovery field is invalid", async () => {
        const projectPath = await makeProject({
            discovery: {
                maxPages: "not-a-number",
                maxDepth: 7,
                preserveQueryParams: true,
                timeout: -1,
            },
        });
        expect(loadDiscoveryConfig(projectPath)).toMatchObject({
            maxPages: defaultConfig.discovery.maxPages,
            maxDepth: 7,
            preserveQueryParams: true,
            timeout: defaultConfig.discovery.timeout,
        });
    });

    it("falls back invalid discovery fields to defaults", async () => {
        const projectPath = await makeProject({
            discovery: { maxPages: "not-a-number" },
        });
        expect(loadDiscoveryConfig(projectPath)).toEqual(defaultConfig.discovery);
    });
});

describe("resolveSiteDiscoveryOptions contract", () => {
    const baseConfig = {
        discovery: {
            maxPages: 80,
            maxDepth: 4,
            maxConcurrency: 2,
            timeout: 15_000,
            excludePatterns: ["/api/"],
            pauseOnAuth: false,
            maxRunTimeMs: 600_000,
            preserveQueryParams: true,
        },
    };

    it("fresh CLI path: explicit flags override config, absent flags use config", async () => {
        const projectPath = await makeProject(baseConfig);

        const cliFresh = resolveSiteDiscoveryOptions({
            projectPath,
            startUrl: "https://app.test/",
            overrides: {
                maxPages: "50",
                timeout: "99999",
            },
            resolveStorageState: false,
        });

        expect(cliFresh).toMatchObject({
            projectPath,
            startUrl: "https://app.test/",
            maxPages: 50,
            maxDepth: 4,
            maxConcurrency: 2,
            timeout: 99_999,
            excludePatterns: ["/api/"],
            pauseOnAuth: false,
            preserveQueryParams: true,
            maxRunTimeMs: 600_000,
            storageStatePath: null,
            continueSession: false,
            purgeQueueOnResume: false,
        });
    });

    it("settle defaults resolve from config + override", async () => {
        const defaults = resolveSiteDiscoveryOptions({
            projectPath: await makeProject({ discovery: {} }),
            startUrl: "https://app.test/",
            resolveStorageState: false,
        });
        expect(defaults.settleQuietMs).toBe(400);
        expect(defaults.settleMaxMs).toBe(3000);

        const fromConfig = resolveSiteDiscoveryOptions({
            projectPath: await makeProject({
                discovery: { settleQuietMs: 600, settleMaxMs: 5000 },
            }),
            startUrl: "https://app.test/",
            resolveStorageState: false,
        });
        expect(fromConfig.settleQuietMs).toBe(600);
        expect(fromConfig.settleMaxMs).toBe(5000);

        const fromOverride = resolveSiteDiscoveryOptions({
            projectPath: await makeProject({ discovery: { settleQuietMs: 600 } }),
            startUrl: "https://app.test/",
            overrides: { settleQuietMs: "250" },
            resolveStorageState: false,
        });
        expect(fromOverride.settleQuietMs).toBe(250);
    });

    it("REPL fresh path matches CLI when given the same numeric overrides", async () => {
        const projectPath = await makeProject(baseConfig);

        const replFresh = resolveSiteDiscoveryOptions({
            projectPath,
            startUrl: "https://app.test/",
            overrides: {
                maxPages: 25,
                maxDepth: 3,
                timeout: 20_000,
            },
            resolveStorageState: false,
        });

        const cliFresh = resolveSiteDiscoveryOptions({
            projectPath,
            startUrl: "https://app.test/",
            overrides: {
                maxPages: "25",
                maxDepth: "3",
                timeout: "20000",
            },
            resolveStorageState: false,
        });

        expect(replFresh).toEqual(cliFresh);
    });

    it("router/dashboard path matches factory when passing session limits via overrides", async () => {
        const projectPath = await makeProject(baseConfig);

        const routerStyle = resolveSiteDiscoveryOptions({
            projectPath,
            startUrl: "https://app.test/dashboard",
            overrides: {
                maxPages: 60,
                maxDepth: 2,
                continueSession: true,
                purgeQueueOnResume: true,
            },
            resolveStorageState: false,
        });

        expect(routerStyle).toMatchObject({
            maxPages: 60,
            maxDepth: 2,
            continueSession: true,
            purgeQueueOnResume: true,
            preserveQueryParams: true,
        });
    });

    it("CLI continue path prefers session limits over explicit flags", async () => {
        const projectPath = await makeProject(baseConfig);

        const continued = resolveSiteDiscoveryOptions({
            projectPath,
            startUrl: "",
            preferSessionLimits: true,
            session: { maxPages: 12, maxDepth: 1 },
            overrides: {
                maxPages: "99",
                maxDepth: "9",
                continueSession: true,
            },
            resolveStorageState: false,
        });

        expect(continued.maxPages).toBe(12);
        expect(continued.maxDepth).toBe(1);
        expect(continued.continueSession).toBe(true);
    });

    it("skipAuth forces pauseOnAuth false across entry points", async () => {
        const projectPath = await makeProject({
            discovery: { pauseOnAuth: true },
        });

        for (const overrides of [{ skipAuth: true }, { skipAuth: true, pauseOnAuth: true }]) {
            const options = resolveSiteDiscoveryOptions({
                projectPath,
                startUrl: "https://app.test/",
                overrides,
                resolveStorageState: false,
            });
            expect(options.pauseOnAuth).toBe(false);
        }
    });

    it("honors preserveQueryParams from config when not overridden", async () => {
        const projectPath = await makeProject({
            discovery: { preserveQueryParams: true },
        });

        expect(
            resolveSiteDiscoveryOptions({
                projectPath,
                startUrl: "https://app.test/",
                resolveStorageState: false,
            }).preserveQueryParams,
        ).toBe(true);

        const projectPathOff = await makeProject({
            discovery: { preserveQueryParams: false },
        });
        expect(
            resolveSiteDiscoveryOptions({
                projectPath: projectPathOff,
                startUrl: "https://app.test/",
                resolveStorageState: false,
            }).preserveQueryParams,
        ).toBe(false);
    });

    it("uses config excludePatterns when override is empty", async () => {
        const projectPath = await makeProject(baseConfig);

        const options = resolveSiteDiscoveryOptions({
            projectPath,
            startUrl: "https://app.test/",
            overrides: { excludePatterns: [] },
            resolveStorageState: false,
        });

        expect(options.excludePatterns).toEqual(["/api/"]);
    });

    it("invalid numeric overrides fall back to config", async () => {
        const projectPath = await makeProject(baseConfig);

        const options = resolveSiteDiscoveryOptions({
            projectPath,
            startUrl: "https://app.test/",
            overrides: { maxPages: "nope", timeout: "" },
            resolveStorageState: false,
        });

        expect(options.maxPages).toBe(80);
        expect(options.timeout).toBe(15_000);
    });
});
