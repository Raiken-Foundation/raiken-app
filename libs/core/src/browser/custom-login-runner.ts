import { spawn } from "node:child_process";
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
import { killProcessTree } from "../testing/process-tree";

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
const STALE_TEMP_MS = 10 * 60 * 1000;

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

async function sweepStaleSpecs(testDir: string): Promise<void> {
    try {
        const now = Date.now();
        for (const name of await fs.readdir(testDir)) {
            const timestamp = Number(name.match(/^raiken-auth-(\d+)-.+\.spec\.ts$/)?.[1]);
            if (Number.isFinite(timestamp) && now - timestamp > STALE_TEMP_MS) {
                await fs.rm(path.join(testDir, name), { force: true });
            }
        }
    } catch {
        // The test directory may not exist yet.
    }
}

async function runPlaywright(
    projectPath: string,
    specPath: string,
    configPath: string | null,
    environment: NodeJS.ProcessEnv,
    timeoutMs: number,
    headed: boolean,
    signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const command = process.platform === "win32" ? "npx.cmd" : "npx";
        const args = ["--no-install", "playwright", "test", path.relative(projectPath, specPath)];
        args.push("--workers=1", "--reporter=line");
        if (headed) args.push("--headed");
        if (configPath) args.push("--config", configPath);

        const child = spawn(command, args, {
            cwd: projectPath,
            detached: process.platform !== "win32",
            env: environment,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const terminate = () => {
            if (child.pid) killProcessTree(child.pid, "SIGTERM");
            setTimeout(() => {
                if (child.pid) killProcessTree(child.pid, "SIGKILL");
            }, 5000).unref();
        };
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            if (error) reject(error);
            else resolve({ stdout, stderr });
        };
        const onAbort = () => {
            terminate();
            finish(new DOMException("Custom login cancelled", "AbortError"));
        };
        const timer = setTimeout(() => {
            terminate();
            finish(new Error(`Custom login timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs + 5000);

        child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.once("error", (error) => finish(error));
        child.once("close", (code) => {
            if (code === 0) finish();
            else {
                finish(
                    new Error(
                        `Custom login script failed (exit ${code ?? "unknown"}). ` +
                            "Run the script with your project Playwright configuration for detailed output.",
                    ),
                );
            }
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
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
    await sweepStaleSpecs(testDir);

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
