import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
    loadAuthConfig,
    resolveAuthCredentials,
    resolveAuthStorageStateDestination,
    resolvePathWithinProject,
    writeValidatedAuthState,
} from "../config";
import { acquireProjectOperation } from "../operations";
import { findPlaywrightConfigPath, readPlaywrightTestDir } from "../testing/playwright-config";
import {
    customLoginPlaywrightSpawnOptions,
    runPlaywrightSubprocess,
} from "../testing/playwright-subprocess";
import { sweepStaleAuthSpecs } from "../testing/raiken-temp-specs";

export interface CustomLoginScriptOptions {
    projectPath: string;
    scriptPath?: string;
    storageStatePath?: string;
    url?: string;
    timeoutMs?: number;
    headed?: boolean;
    signal?: AbortSignal;
}

export interface CustomLoginScriptResult {
    scriptPath: string;
    storageStatePath: string;
    cookies: number;
    origins: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export function buildCustomLoginSpec(args: {
    scriptImport: string;
    url?: string;
    timeoutMs: number;
}): string {
    const navigate = args.url
        ? `    await page.goto(${JSON.stringify(args.url)}, { waitUntil: "domcontentloaded" });\n`
        : "";
    return `import { test } from "@playwright/test";
import login from ${JSON.stringify(args.scriptImport)};

test("Raiken custom login", async ({ page, context }) => {
    test.setTimeout(${args.timeoutMs});
${navigate}    await login({
        page,
        context,
        credentials: {
            username: process.env.RAIKEN_AUTH_USERNAME,
            password: process.env.RAIKEN_AUTH_PASSWORD,
        },
    });
    const destination = process.env.RAIKEN_AUTH_STATE_PATH;
    if (!destination) throw new Error("RAIKEN_AUTH_STATE_PATH is not set");
    await context.storageState({ path: destination });
});
`;
}

function resolveLoginUrl(projectPath: string, explicitUrl: string | undefined): string | undefined {
    if (explicitUrl) return explicitUrl;
    const auth = loadAuthConfig(projectPath);
    if (!auth.baseUrl) return undefined;
    try {
        return new URL(auth.loginPath || "/", auth.baseUrl).href;
    } catch {
        return undefined;
    }
}

function redactKnownSecrets(value: string, secrets: Array<string | undefined>): string {
    let redacted = value;
    for (const secret of secrets) {
        if (secret && secret.length > 0) redacted = redacted.split(secret).join("[REDACTED]");
    }
    return redacted;
}

/** Safe, non-secret diagnostics for a failed custom-login Playwright run. */
export interface CustomLoginFailureDiagnostics {
    exitCode: number | null;
    specBasename: string;
    configBasename: string | null;
    headed: boolean;
    timedOut?: boolean;
    cancelled?: boolean;
    timeoutSeconds?: number;
}

export function formatCustomLoginFailureMessage(
    diagnostics: CustomLoginFailureDiagnostics,
): string {
    if (diagnostics.cancelled) {
        return "Custom login cancelled";
    }
    if (diagnostics.timedOut) {
        const suffix =
            typeof diagnostics.timeoutSeconds === "number"
                ? ` after ${diagnostics.timeoutSeconds}s`
                : "";
        return `Custom login timed out${suffix}. Spec: ${diagnostics.specBasename}. Config: ${diagnostics.configBasename ?? "default"}.`;
    }
    const configLabel = diagnostics.configBasename ?? "default";
    return (
        `Custom login script failed (exit ${diagnostics.exitCode ?? "unknown"}). ` +
        `Spec: ${diagnostics.specBasename}. Config: ${configLabel}. ` +
        `Headed: ${diagnostics.headed ? "yes" : "no"}. ` +
        "Run the script with your project Playwright configuration for detailed output."
    );
}

async function runPlaywright(
    projectPath: string,
    specPath: string,
    configPath: string | null,
    environment: NodeJS.ProcessEnv,
    timeoutMs: number,
    headed: boolean,
    signal?: AbortSignal,
): Promise<void> {
    const args = ["--no-install", "playwright", "test", path.relative(projectPath, specPath)];
    args.push("--workers=1", "--reporter=line");
    if (headed) args.push("--headed");
    if (configPath) args.push("--config", configPath);

    const subprocess = await runPlaywrightSubprocess(
        customLoginPlaywrightSpawnOptions({
            cwd: projectPath,
            args,
            env: environment,
            signal,
            timeoutMs,
            timeoutGraceMs: 5000,
        }),
    );

    const diagnostics: CustomLoginFailureDiagnostics = {
        exitCode: subprocess.exitCode,
        specBasename: path.basename(specPath),
        configBasename: configPath ? path.basename(configPath) : null,
        headed,
        timedOut: subprocess.timedOut,
        cancelled: subprocess.cancelled,
    };

    if (subprocess.cancelled) {
        throw new DOMException(formatCustomLoginFailureMessage(diagnostics), "AbortError");
    }
    if (subprocess.timedOut) {
        throw new Error(
            formatCustomLoginFailureMessage({
                ...diagnostics,
                exitCode: null,
                timeoutSeconds: Math.round(timeoutMs / 1000),
            }),
        );
    }
    if (subprocess.spawnError) {
        throw subprocess.spawnError;
    }
    if (subprocess.exitCode !== 0) {
        throw new Error(formatCustomLoginFailureMessage(diagnostics));
    }
}

export async function runCustomLoginScript(
    options: CustomLoginScriptOptions,
): Promise<CustomLoginScriptResult> {
    const projectPath = path.resolve(options.projectPath);
    const auth = loadAuthConfig(projectPath);
    const configuredScript = options.scriptPath ?? auth.customLoginScript;
    if (!configuredScript) {
        throw new Error(
            "No custom login script is configured. Set auth.customLoginScript or pass --script.",
        );
    }

    const scriptPath = resolvePathWithinProject(projectPath, configuredScript);
    const storageStatePath = options.storageStatePath
        ? resolvePathWithinProject(projectPath, options.storageStatePath)
        : resolveAuthStorageStateDestination(projectPath);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error("Custom login timeout must be a positive number.");
    }

    const stat = await fs.stat(scriptPath).catch(() => null);
    if (!stat?.isFile()) throw new Error(`Custom login script not found: ${scriptPath}`);

    const testDirRelative = (await readPlaywrightTestDir(projectPath)) ?? "e2e";
    const testDir = resolvePathWithinProject(projectPath, testDirRelative);
    await fs.mkdir(testDir, { recursive: true });
    await fs.mkdir(path.dirname(storageStatePath), { recursive: true });
    await sweepStaleAuthSpecs(projectPath, testDir);

    const id = `${Date.now()}-${randomUUID()}`;
    const specPath = path.join(testDir, `raiken-auth-${id}.spec.ts`);
    const temporaryStatePath = `${storageStatePath}.tmp-${id}`;
    let scriptImport = path.relative(testDir, scriptPath).replaceAll(path.sep, "/");
    if (!scriptImport.startsWith(".")) scriptImport = `./${scriptImport}`;

    const credentials = resolveAuthCredentials(projectPath);
    const spec = buildCustomLoginSpec({
        scriptImport,
        url: resolveLoginUrl(projectPath, options.url),
        timeoutMs,
    });
    const lease = await acquireProjectOperation(projectPath, "browser", options.signal);
    try {
        await fs.writeFile(specPath, spec, { encoding: "utf-8", mode: 0o600 });
        await fs.writeFile(temporaryStatePath, '{"cookies":[],"origins":[]}', {
            encoding: "utf-8",
            mode: 0o600,
        });
        const configPath = await findPlaywrightConfigPath(projectPath);
        const environment = {
            ...process.env,
            RAIKEN_AUTH_STATE_PATH: temporaryStatePath,
            RAIKEN_AUTH_USERNAME: credentials.username,
            RAIKEN_AUTH_PASSWORD: credentials.password,
        };
        try {
            await runPlaywright(
                projectPath,
                specPath,
                configPath,
                environment,
                timeoutMs,
                options.headed ?? false,
                options.signal,
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(
                redactKnownSecrets(message, [credentials.username, credentials.password]),
            );
        }

        const state = JSON.parse(await fs.readFile(temporaryStatePath, "utf-8")) as unknown;
        const inspection = writeValidatedAuthState(storageStatePath, state);
        return {
            scriptPath,
            storageStatePath,
            cookies: inspection.cookieCount,
            origins: inspection.origins.length,
        };
    } finally {
        await fs.rm(specPath, { force: true }).catch(() => undefined);
        await fs.rm(temporaryStatePath, { force: true }).catch(() => undefined);
        await lease.release();
    }
}
