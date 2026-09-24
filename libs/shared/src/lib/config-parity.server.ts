/**
 * Server-only compile-time contracts proving shared transport config types
 * match `@raiken/core` public/redacted shapes. Never import this module from
 * the browser entry (`@raiken/shared`).
 */
import type {
    AIProviderId as CoreAIProviderId,
    HitlWorkflowRecord as CoreHitlWorkflowRecord,
    PublicRaikenConfig as CorePublicRaikenConfig,
    ResolvedRaikenConfig,
    TestRunResult,
} from "@raiken/core";
import type {
    AIProviderId,
    PublicRaikenConfig,
    RaikenConfig as UiRaikenConfig,
} from "./config-public";
import type {
    HitlTestRunResultTransport,
    HitlWorkflowRecord as TransportHitlWorkflowRecord,
} from "./hitl-workflow";
import type { AssertMutuallyExact, ExpectTrue } from "./type-parity";

/** Redacted config returned by `getConfig` must match exactly across the wire. */
export type PublicRaikenConfigParity = AssertMutuallyExact<
    PublicRaikenConfig,
    CorePublicRaikenConfig
>;
export type AIProviderIdParity = AssertMutuallyExact<AIProviderId, CoreAIProviderId>;

/** Dashboard placeholder keys must mirror resolved core defaults. */
type UiDefaultKeys = keyof UiRaikenConfig;
type UiRaikenConfigForParity = Omit<UiRaikenConfig, "auth" | "ai" | "browser" | "integrations"> & {
    ai: Pick<ResolvedRaikenConfig, "ai">;
    auth: Pick<ResolvedRaikenConfig, "auth">;
    browser: Pick<ResolvedRaikenConfig, "browser">;
    integrations: Pick<ResolvedRaikenConfig, "integrations">;
};
export type UiRaikenDefaultsParity = AssertMutuallyExact<
    UiRaikenConfigForParity,
    Pick<ResolvedRaikenConfig, UiDefaultKeys>
>;

/** Single test attempt payloads must round-trip without loss. */
export type HitlTestRunResultParity = AssertMutuallyExact<
    HitlTestRunResultTransport,
    TestRunResult
>;

/** Active workflow cards must deserialize from core records without loss. */
export type HitlWorkflowRecordParity = AssertMutuallyExact<
    TransportHitlWorkflowRecord,
    CoreHitlWorkflowRecord
>;

type _ConfigParityChecks = ExpectTrue<
    AIProviderIdParity &
        PublicRaikenConfigParity &
        UiRaikenDefaultsParity &
        HitlTestRunResultParity &
        HitlWorkflowRecordParity
>;

/** Compile-time drift gate — must stay `true` when types match. */
export type ConfigParityVerified = _ConfigParityChecks;

/** Runtime guard used by tests — core config is the canonical source of truth. */
export function uiDefaultFieldsFromCore(core: ResolvedRaikenConfig): UiRaikenConfig {
    return {
        projectType: core.projectType,
        testDirectory: core.testDirectory,
        playwrightConfig: core.playwrightConfig,
        outputFormats: core.outputFormats,
        ai: {
            provider: core.ai.provider ?? "openrouter",
            model: core.ai.model ?? "",
            maxTokens: core.ai.maxTokens,
            temperature: core.ai.temperature,
            baseURL: core.ai.baseURL,
        },
        auth: {},
        browser: {
            defaultBrowser: core.browser.defaultBrowser ?? "chromium",
            headless: core.browser.headless ?? true,
            timeout: core.browser.timeout ?? 30000,
            retries: core.browser.retries ?? 1,
        },
        features: {
            video: core.features.video ?? true,
            screenshots: core.features.screenshots ?? true,
            tracing: core.features.tracing ?? false,
            network: core.features.network ?? true,
        },
        autonomy: {
            autoSaveTests: core.autonomy.autoSaveTests ?? false,
            autoRunTests: core.autonomy.autoRunTests ?? false,
            autoCorrect: core.autonomy.autoCorrect ?? "suggest",
            autoLearn: core.autonomy.autoLearn ?? "confirm",
            maxRetries: core.autonomy.maxRetries ?? 2,
        },
        discovery: {
            maxPages: core.discovery.maxPages ?? 100,
            maxDepth: core.discovery.maxDepth ?? 5,
            maxConcurrency: core.discovery.maxConcurrency ?? 3,
            timeout: core.discovery.timeout ?? 30000,
            excludePatterns: core.discovery.excludePatterns ?? [],
            pauseOnAuth: core.discovery.pauseOnAuth ?? true,
            maxRunTimeMs: core.discovery.maxRunTimeMs ?? 30 * 60 * 1000,
            preserveQueryParams: core.discovery.preserveQueryParams ?? false,
        },
        indexing: { fullScan: core.indexing.fullScan ?? false },
        integrations: {
            provider: core.integrations.provider ?? "github",
            ...(core.integrations.branchPatterns
                ? { branchPatterns: core.integrations.branchPatterns }
                : {}),
        },
    };
}
