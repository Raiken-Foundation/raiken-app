#!/usr/bin/env node
/**
 * Cross-platform smoke test for the built CLI artifact.
 * Used locally and in CI after `nx build cli`.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliRoot = path.join(repoRoot, "dist", "apps", "cli");
const cliBin = path.join(cliRoot, "bin.cjs");
const cliPackagePath = path.join(cliRoot, "package.json");
const smokePort = Number(process.env.RAIKEN_SMOKE_PORT ?? "7199");

function fail(message) {
    console.error(`smoke:cli — ${message}`);
    process.exit(1);
}

function runNode(args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, {
            cwd: options.cwd ?? repoRoot,
            env: { ...process.env, ...(options.env ?? {}) },
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject(new Error(`exit ${code}: ${stderr || stdout}`));
            }
        });
    });
}

async function waitForHealth(port, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            const body = await new Promise((resolve, reject) => {
                const request = http.get(
                    {
                        hostname: "127.0.0.1",
                        port,
                        path: "/api/trpc/getHealth",
                    },
                    (response) => {
                        let data = "";
                        response.on("data", (chunk) => {
                            data += chunk;
                        });
                        response.on("end", () => {
                            if (
                                response.statusCode &&
                                response.statusCode >= 200 &&
                                response.statusCode < 300
                            ) {
                                resolve(data);
                                return;
                            }
                            reject(new Error(`health HTTP ${response.statusCode}`));
                        });
                    },
                );
                request.on("error", reject);
                request.setTimeout(2_000, () => {
                    request.destroy(new Error("health request timed out"));
                });
            });

            return body;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }

    throw new Error(`health check did not succeed within ${timeoutMs}ms`);
}

async function main() {
    if (!fs.existsSync(cliBin)) {
        fail(`missing built CLI at ${cliBin}. Run "pnpm exec nx build cli" first.`);
    }
    if (!fs.existsSync(cliPackagePath)) {
        fail(`missing packaged CLI metadata at ${cliPackagePath}.`);
    }

    const cliPackage = JSON.parse(fs.readFileSync(cliPackagePath, "utf-8"));
    const expectedVersion = cliPackage.version;
    if (!expectedVersion) {
        fail("dist/apps/cli/package.json is missing a version field.");
    }

    const { stdout: versionOutput } = await runNode([cliBin, "--version"]);
    const printedVersion = versionOutput.trim();
    if (!printedVersion.includes(expectedVersion)) {
        fail(`"--version" printed "${printedVersion}", expected "${expectedVersion}".`);
    }
    console.log(`smoke:cli — version OK (${expectedVersion})`);

    const server = spawn(process.execPath, [cliBin, "start", "-p", String(smokePort)], {
        cwd: repoRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
    });

    let serverLog = "";
    server.stdout.on("data", (chunk) => {
        serverLog += chunk.toString();
    });
    server.stderr.on("data", (chunk) => {
        serverLog += chunk.toString();
    });

    const shutdown = () => {
        if (!server.killed) {
            server.kill("SIGTERM");
        }
    };
    process.on("exit", shutdown);

    try {
        const healthBody = await waitForHealth(smokePort);
        if (!healthBody.includes('"status":"ok"') && !healthBody.includes('"status": "ok"')) {
            fail(`getHealth response did not report ok: ${healthBody.slice(0, 200)}`);
        }
        if (!healthBody.includes(`"version":"${expectedVersion}"`)) {
            fail(
                `getHealth did not report packaged version ${expectedVersion}: ${healthBody.slice(0, 200)}`,
            );
        }
        console.log("smoke:cli — health OK");
    } catch (error) {
        fail(
            `server smoke failed: ${error instanceof Error ? error.message : String(error)}\n${serverLog}`,
        );
    } finally {
        shutdown();
        await new Promise((resolve) => {
            server.on("close", resolve);
            setTimeout(resolve, 5_000);
        });
    }

    console.log("smoke:cli — passed");
}

main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
});
