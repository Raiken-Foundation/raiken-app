import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Source route extraction — the code-graph route map.
 *
 * Raiken is a local tool; the app's source is right there. Extracting the
 * route table statically gives the snapshotter a checklist instead of a link
 * frontier: every known route gets visited regardless of how it's reachable.
 *
 * v1 covers the two dominant patterns:
 *  - Next.js App Router (`app/<segments>/page.tsx` → `/<segments>`, with
 *    `[param]` segments noted as dynamic)
 *  - React Router v6+ route tables (`path: "/x"` entries in
 *    createBrowserRouter/useRoutes configs or <Route path="/x"> JSX)
 */

export interface SourceRoute {
    /** URL path, e.g. `/checkout`, `/users/[id]`. */
    path: string;
    /** Relative source file the route came from. */
    sourceFile: string;
    /** "next-app" | "react-router" */
    source: "next-app" | "react-router";
    /** True when the path contains dynamic segments ([id], :id). */
    dynamic: boolean;
}

const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", "out", ".raiken"]);
const MAX_FILES = 2_000;

export function extractSourceRoutes(projectPath: string): SourceRoute[] {
    const routes: SourceRoute[] = [];
    const seen = new Set<string>();
    const files = walkSourceFiles(projectPath);
    for (const file of files) {
        const rel = path.relative(projectPath, file).split(path.sep).join("/");
        for (const route of routesFromNextAppDir(rel)) {
            if (seen.has(route.path)) continue;
            seen.add(route.path);
            routes.push(route);
        }
        if (/router|routes?|navigation/i.test(rel)) {
            let content: string;
            try {
                content = fs.readFileSync(file, "utf-8");
            } catch {
                continue;
            }
            for (const route of routesFromReactRouter(rel, content)) {
                if (seen.has(route.path)) continue;
                seen.add(route.path);
                routes.push(route);
            }
        }
    }
    return routes.sort((a, b) => a.path.localeCompare(b.path));
}

/** Next.js App Router: app/<segments>/page.<ext> → /<segments>. */
function routesFromNextAppDir(rel: string): SourceRoute[] {
    const m = rel.match(/^app\/(.+\/)?page\.(tsx|ts|jsx|js)$/);
    if (!m) return [];
    const segments = (m[1] ?? "").replace(/\/$/, "");
    const pathName = segments
        ? `/${segments}`
              .replace(/\([^)]*\)/g, "") // route groups
              .replace(/\/+/g, "/")
              .replace(/\/$/, "")
        : "/";
    const dynamic = /\[[^\]]+\]/.test(pathName);
    return [{ path: pathName || "/", sourceFile: rel, source: "next-app", dynamic }];
}

/** React Router: `path: "/x"` table entries and <Route path="/x"> JSX. */
function routesFromReactRouter(rel: string, content: string): SourceRoute[] {
    const out: SourceRoute[] = [];
    const table = content.matchAll(/path\s*:\s*["'`]([^"'`]+)["'`]/g);
    for (const match of table) {
        const p = match[1];
        if (!p.startsWith("/")) continue;
        out.push({
            path: p.replace(/\/:[^/]+/g, "/[param]"),
            sourceFile: rel,
            source: "react-router",
            dynamic: /[:*[]/.test(p),
        });
    }
    const jsx = content.matchAll(/<Route[^>]*path\s*=\s*{?["'`]([^"'`}]+)["'`]/g);
    for (const match of jsx) {
        const p = match[1];
        if (!p.startsWith("/")) continue;
        out.push({
            path: p.replace(/\/:[^/]+/g, "/[param]"),
            sourceFile: rel,
            source: "react-router",
            dynamic: /[:*[]/.test(p),
        });
    }
    return out;
}

function walkSourceFiles(root: string): string[] {
    const out: string[] = [];
    const stack = [root];
    while (stack.length > 0 && out.length < MAX_FILES) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name)) stack.push(full);
            } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
                out.push(full);
            }
        }
    }
    return out;
}
