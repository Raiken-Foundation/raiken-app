import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Best-effort detection of a project's dev-server port.
 *
 * Strategy (first hit wins):
 *   1. `vite.config.{ts,js,mjs,mts,cjs}` → `server.port`
 *   2. `next.config.{ts,js,mjs,cjs}` → no port field; fall through to package.json
 *   3. `angular.json` → `projects.<any>.architect.serve.options.port`
 *   4. `package.json` `scripts.{dev,start,serve}` → `--port N` / `-p N` / `--port=N`
 *   5. `fallback` (argument) → caller-supplied default
 *
 * Returns a positive integer port, never throws. All file IO is best-effort:
 * unreadable / missing / malformed files are silently skipped so this function
 * is safe to call against any project shape.
 */
export async function detectDevServerPort(projectPath: string, fallback = 3000): Promise<number> {
    const detectors: Array<() => Promise<number | null>> = [
        () => detectViteConfigPort(projectPath),
        () => detectAngularJsonPort(projectPath),
        () => detectPackageScriptPort(projectPath),
    ];

    for (const detect of detectors) {
        try {
            const port = await detect();
            if (port && Number.isInteger(port) && port > 0 && port < 65536) {
                return port;
            }
        } catch {
            // Detector blew up on malformed input — try the next one.
        }
    }

    return fallback;
}

/**
 * Look for `server.port` in any of the standard Vite config filenames.
 *
 * We can't safely *execute* the file (it might import Node-only or workspace
 * packages), so we use a forgiving regex. This handles the common forms:
 *   server: { port: 3000 }
 *   server: { port: 3000, ... }
 *   server: { host: 'x', port: 3000 }
 * and any whitespace / line breaks in between.
 */
async function detectViteConfigPort(projectPath: string): Promise<number | null> {
    const candidates = [
        "vite.config.ts",
        "vite.config.mts",
        "vite.config.js",
        "vite.config.mjs",
        "vite.config.cjs",
    ];

    for (const candidate of candidates) {
        const content = await readFileOrNull(path.join(projectPath, candidate));
        if (!content) continue;

        // Look for `server: { ... port: NNN ... }` allowing arbitrary nested
        // properties / comments before/after the port key. Multiline.
        const serverBlock = content.match(/server\s*:\s*\{([\s\S]*?)\}/);
        if (serverBlock) {
            const portMatch = serverBlock[1].match(/\bport\s*:\s*(\d{2,5})/);
            if (portMatch) {
                const port = Number.parseInt(portMatch[1], 10);
                if (!Number.isNaN(port)) return port;
            }
        }
    }

    return null;
}

/**
 * Read `angular.json` and look for the first project's `serve` builder port.
 *
 * Angular CLI defaults to 4200 if no override is set; in that case we return
 * null so the caller can fall back to its own default rather than us
 * synthesizing 4200 from thin air.
 */
async function detectAngularJsonPort(projectPath: string): Promise<number | null> {
    const angularJsonPath = path.join(projectPath, "angular.json");
    const content = await readFileOrNull(angularJsonPath);
    if (!content) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch {
        return null;
    }

    const projects =
        typeof parsed === "object" && parsed !== null && "projects" in parsed
            ? (parsed as { projects: Record<string, unknown> }).projects
            : null;
    if (!projects) return null;

    for (const project of Object.values(projects)) {
        const architect = (project as Record<string, unknown>)?.["architect"] as
            | Record<string, unknown>
            | undefined;
        const serve = architect?.["serve"] as Record<string, unknown> | undefined;
        const options = serve?.["options"] as Record<string, unknown> | undefined;
        const port = options?.["port"];
        if (typeof port === "number" && port > 0 && port < 65536) {
            return port;
        }
    }

    return null;
}

/**
 * Inspect `package.json` `scripts.dev | scripts.start | scripts.serve` for an
 * explicit `--port N` / `--port=N` / `-p N` flag.
 *
 * This catches Next.js (`next dev --port 4000`), Nuxt, and any custom dev
 * script that pins a port — none of these have config-file fields we can read.
 */
async function detectPackageScriptPort(projectPath: string): Promise<number | null> {
    const pkgPath = path.join(projectPath, "package.json");
    const content = await readFileOrNull(pkgPath);
    if (!content) return null;

    let pkg: unknown;
    try {
        pkg = JSON.parse(content);
    } catch {
        return null;
    }

    const scripts =
        typeof pkg === "object" && pkg !== null && "scripts" in pkg
            ? (pkg as { scripts: Record<string, unknown> }).scripts
            : null;
    if (!scripts) return null;

    const scriptOrder = ["dev", "start", "serve"];
    for (const key of scriptOrder) {
        const value = scripts[key];
        if (typeof value !== "string") continue;
        const port = extractPortFlag(value);
        if (port !== null) return port;
    }

    return null;
}

/**
 * Pull the port number out of a CLI invocation string. Supports:
 *   `--port 3000`  `--port=3000`  `-p 3000`  `-p=3000`
 * Returns null if the string contains no port flag (e.g. `vite` alone).
 */
export function extractPortFlag(commandLine: string): number | null {
    // --port 3000 / --port=3000
    const long = commandLine.match(/--port[=\s]+(\d{2,5})/);
    if (long) {
        const n = Number.parseInt(long[1], 10);
        if (n > 0 && n < 65536) return n;
    }

    // -p 3000 / -p=3000 (must not be part of a longer flag like --foo-p)
    const short = commandLine.match(/(?:^|\s)-p[=\s]+(\d{2,5})/);
    if (short) {
        const n = Number.parseInt(short[1], 10);
        if (n > 0 && n < 65536) return n;
    }

    return null;
}

async function readFileOrNull(filePath: string): Promise<string | null> {
    try {
        return await fs.readFile(filePath, "utf-8");
    } catch {
        return null;
    }
}
