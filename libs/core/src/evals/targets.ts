/**
 * Target lifecycles for eval scenarios: apps the harness starts before an
 * attempt and tears down after, exposing a `baseUrl` to the task.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import type { EvalTarget } from "./types";

/**
 * Ask the OS for a free port by binding to 0 and releasing it. There's a
 * small race window before the child binds it, but eval targets start
 * sequentially so collisions are practically impossible.
 */
export async function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                server.close(() => reject(new Error("no address from port probe")));
                return;
            }
            const { port } = address;
            server.close(() => resolve(port));
        });
    });
}

const CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".txt": "text/plain",
    ".woff2": "font/woff2",
};

/**
 * Serve a built SPA bundle (a `dist/` folder) over an in-process HTTP server
 * with history-API fallback: unknown paths get `index.html`, the same way
 * `vite preview` behaves. No child process, an OS-assigned free port, fully
 * deterministic — the preferred target for fixture apps.
 */
export function staticSpaTarget(options: { name: string; distDir: string }): EvalTarget {
    let server: http.Server | null = null;

    return {
        name: options.name,
        async start() {
            const distDir = path.resolve(options.distDir);
            if (!fs.existsSync(path.join(distDir, "index.html"))) {
                throw new Error(
                    `staticSpaTarget "${options.name}": no index.html in ${distDir} — build the fixture first`,
                );
            }

            server = http.createServer((req, res) => {
                const url = new URL(req.url ?? "/", "http://localhost");
                // Resolve inside distDir only — a crawler shouldn't be able
                // to walk out of the fixture even by accident.
                let requested: string;
                try {
                    requested = decodeURIComponent(url.pathname).replace(/^[/\\]+/, "");
                } catch {
                    requested = "";
                }
                let filePath = path.resolve(distDir, requested);
                const relative = path.relative(distDir, filePath);
                const isInsideDist =
                    relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
                if (!isInsideDist || path.isAbsolute(relative) || !isFile(filePath)) {
                    filePath = path.join(distDir, "index.html");
                }
                const ext = path.extname(filePath).toLowerCase();
                res.writeHead(200, {
                    "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
                });
                fs.createReadStream(filePath).pipe(res);
            });

            const listening = server;
            await new Promise<void>((resolve, reject) => {
                listening.once("error", reject);
                listening.listen(0, "127.0.0.1", () => resolve());
            });
            const address = listening.address();
            if (!address || typeof address === "string") {
                throw new Error(`staticSpaTarget "${options.name}": no listen address`);
            }
            return { baseUrl: `http://127.0.0.1:${address.port}` };
        },
        async stop() {
            const closing = server;
            server = null;
            if (!closing) return;
            await new Promise<void>((resolve) => closing.close(() => resolve()));
        },
    };
}

/**
 * Spawn an external server command (e.g. a fixture's `server.mjs`) and wait
 * until it answers HTTP on the given port. `{port}` in args is substituted
 * with the chosen port.
 */
export function commandTarget(options: {
    name: string;
    command: string;
    args: string[];
    cwd: string;
    /** Fixed port; omitted = a free one is chosen per start(). */
    port?: number;
    readyTimeoutMs?: number;
}): EvalTarget {
    let child: ChildProcess | null = null;

    return {
        name: options.name,
        async start() {
            const port = options.port ?? (await findFreePort());
            const args = options.args.map((arg) => arg.replace("{port}", String(port)));
            child = spawn(options.command, args, {
                cwd: options.cwd,
                stdio: "ignore",
                detached: false,
            });
            const spawned = child;
            const exitEarly = new Promise<never>((_resolve, reject) => {
                spawned.once("error", reject);
                spawned.once("exit", (code) =>
                    reject(
                        new Error(
                            `commandTarget "${options.name}" exited with code ${code} before becoming ready`,
                        ),
                    ),
                );
            });

            const baseUrl = `http://127.0.0.1:${port}`;
            await Promise.race([waitForHttp(baseUrl, options.readyTimeoutMs ?? 15_000), exitEarly]);
            // Ready — stop treating a future exit as a startup failure.
            spawned.removeAllListeners("error");
            spawned.removeAllListeners("exit");
            return { baseUrl };
        },
        async stop() {
            const stopping = child;
            child = null;
            if (!stopping || stopping.exitCode !== null) return;
            await new Promise<void>((resolve) => {
                const killTimer = setTimeout(() => {
                    stopping.kill("SIGKILL");
                }, 3000);
                stopping.once("exit", () => {
                    clearTimeout(killTimer);
                    resolve();
                });
                stopping.kill("SIGTERM");
            });
        },
    };
}

/** Poll until the URL answers with ANY http response (or time out). */
export async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
        try {
            await new Promise<void>((resolve, reject) => {
                const req = http.get(url, (res) => {
                    res.resume();
                    resolve();
                });
                req.on("error", reject);
                req.setTimeout(2000, () => req.destroy(new Error("request timeout")));
            });
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
    }
    throw new Error(
        `Target at ${url} did not answer within ${timeoutMs}ms: ${
            lastError instanceof Error ? lastError.message : lastError
        }`,
    );
}

function isFile(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}
