import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as parser from "@babel/parser";
import * as t from "@babel/types";
import type { BehaviorFact } from "./types";

/**
 * Impact scoping — which facts can a change actually reach?
 *
 * `scopeFactsByChanges` matches changed-file NAMES against route strings, so
 * an edit to `components/ConfirmDialog.tsx` reaches no fact at all, and a
 * change that reaches nothing verifies nothing. This module answers the
 * question structurally instead:
 *
 *   changed file ──(reverse import/call edges)──▶ page component ──▶ route ──▶ facts
 *
 * The code graph comes from graft (`graft/.graph/wiring.json`, tree-sitter,
 * deterministic, no model). The route → component map comes from the app's
 * own router source. Every scoped fact carries the path that put it in scope,
 * so the decision is explainable. The scoper fails safe: a code change it
 * cannot map to any route widens to the full contract instead of skipping.
 */

// ==========================================================================
// Route bindings: route path → the component files that render it
// ==========================================================================

export type ComponentRef =
    | { kind: "file"; file: string }
    /** A component declared inside the router file itself (e.g. RootLayout). */
    | { kind: "local"; name: string };

export interface RouteBinding {
    /** URL pattern, dynamic segments as `[param]` (matches extractSourceRoutes). */
    path: string;
    /** Absolute path of the file that declares the route. */
    routeFile: string;
    /** Components rendered for this route, outermost layout first. */
    chain: ComponentRef[];
    /**
     * Router-file imports that are not route elements — what local layouts in
     * the router file can render (a cookie banner, a providers wrapper).
     */
    localDeps: string[];
}

const ROUTER_MARKERS =
    /createBrowserRouter|createHashRouter|createMemoryRouter|useRoutes|<Route[\s>]|RouteObject/;
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    ".next",
    "build",
    "out",
    ".raiken",
    "graft",
    "coverage",
]);
const MAX_FILES = 5_000;

export function extractRouteBindings(projectPath: string): RouteBinding[] {
    const bindings: RouteBinding[] = [];
    for (const file of walkSourceFiles(projectPath)) {
        const rel = path.relative(projectPath, file).split(path.sep).join("/");
        const next = nextAppBinding(projectPath, rel);
        if (next) {
            bindings.push(next);
            continue;
        }
        let content: string;
        try {
            content = fs.readFileSync(file, "utf-8");
        } catch {
            continue;
        }
        if (!ROUTER_MARKERS.test(content)) continue;
        bindings.push(...reactRouterBindings(file, content));
    }
    return bindings;
}

/** Next.js App Router: the page plus every layout above it renders the route. */
function nextAppBinding(projectPath: string, rel: string): RouteBinding | null {
    const m = rel.match(/^(?:src\/)?app\/(.+\/)?page\.(tsx|ts|jsx|js)$/);
    if (!m) return null;
    const appRoot = rel.startsWith("src/") ? "src/app" : "app";
    const segments = (m[1] ?? "").replace(/\/$/, "");
    const chain: ComponentRef[] = [];
    let dir = appRoot;
    const parts = segments ? segments.split("/") : [];
    for (let i = 0; i <= parts.length; i++) {
        for (const ext of ["tsx", "ts", "jsx", "js"]) {
            const layout = path.join(projectPath, dir, `layout.${ext}`);
            if (fs.existsSync(layout)) chain.push({ kind: "file", file: layout });
        }
        if (i < parts.length) dir = `${dir}/${parts[i]}`;
    }
    const pageFile = path.join(projectPath, rel);
    chain.push({ kind: "file", file: pageFile });
    const urlPath =
        `/${segments}`
            .replace(/\([^)]*\)/g, "")
            .replace(/\/+/g, "/")
            .replace(/\/$/, "") || "/";
    return { path: urlPath, routeFile: pageFile, chain, localDeps: [] };
}

/** React Router: object route tables and <Route> JSX, with layout nesting. */
function reactRouterBindings(file: string, content: string): RouteBinding[] {
    let ast: t.File;
    try {
        ast = parser.parse(content, {
            sourceType: "module",
            plugins: ["typescript", "jsx"],
            errorRecovery: true,
        });
    } catch {
        return [];
    }

    const imports = new Map<string, string>();
    const sideEffectImports: string[] = [];
    const locals = new Set<string>();
    for (const stmt of ast.program.body) {
        if (t.isImportDeclaration(stmt)) {
            const resolved = resolveImport(file, stmt.source.value);
            if (!resolved) continue;
            for (const spec of stmt.specifiers) imports.set(spec.local.name, resolved);
            // `import "./styles.css"` renders on every route a local layout wraps.
            if (stmt.specifiers.length === 0) sideEffectImports.push(resolved);
            continue;
        }
        const decl =
            t.isExportNamedDeclaration(stmt) || t.isExportDefaultDeclaration(stmt)
                ? stmt.declaration
                : stmt;
        if (t.isFunctionDeclaration(decl) && decl.id) locals.add(decl.id.name);
        if (t.isVariableDeclaration(decl)) {
            for (const d of decl.declarations) if (t.isIdentifier(d.id)) locals.add(d.id.name);
        }
    }

    const toRef = (name: string | null): ComponentRef | null => {
        if (!name) return null;
        const imported = imports.get(name);
        if (imported) return { kind: "file", file: imported };
        if (locals.has(name)) return { kind: "local", name };
        return null; // a library component (Navigate, Outlet) — renders no app code
    };

    const bindings: RouteBinding[] = [];
    const elementFiles = new Set<string>();
    const emit = (routePath: string, chain: ComponentRef[]) => {
        for (const ref of chain) if (ref.kind === "file") elementFiles.add(ref.file);
        bindings.push({ path: routePath, routeFile: file, chain, localDeps: [] });
    };

    const visitRouteObject = (
        obj: t.ObjectExpression,
        parentPath: string,
        parentChain: ComponentRef[],
    ) => {
        const props = objectProps(obj);
        const own = toRef(
            elementName(props.get("element")) ?? identifierName(props.get("Component")),
        );
        const chain = own ? [...parentChain, own] : parentChain;
        const pathNode = props.get("path");
        const hasPath = t.isStringLiteral(pathNode);
        const routePath = t.isStringLiteral(pathNode)
            ? joinRoutePath(parentPath, pathNode.value)
            : parentPath;
        if (hasPath || t.isBooleanLiteral(props.get("index"))) emit(routePath, chain);
        const children = props.get("children");
        if (t.isArrayExpression(children)) {
            for (const child of children.elements) {
                if (t.isObjectExpression(child)) visitRouteObject(child, routePath, chain);
            }
        }
    };

    const visitRouteJsx = (el: t.JSXElement, parentPath: string, parentChain: ComponentRef[]) => {
        let own: ComponentRef | null = null;
        let routePath = parentPath;
        let emitIt = false;
        for (const attr of el.openingElement.attributes) {
            if (!t.isJSXAttribute(attr) || !t.isJSXIdentifier(attr.name)) continue;
            const name = attr.name.name;
            const value = attr.value;
            if (name === "path" && t.isStringLiteral(value)) {
                routePath = joinRoutePath(parentPath, value.value);
                emitIt = true;
            } else if (name === "index") {
                emitIt = true;
            } else if (
                t.isJSXExpressionContainer(value) &&
                !t.isJSXEmptyExpression(value.expression)
            ) {
                if (name === "element") own = toRef(elementName(value.expression));
                if (name === "Component") own = toRef(identifierName(value.expression));
            }
        }
        const chain = own ? [...parentChain, own] : parentChain;
        if (emitIt) emit(routePath, chain);
        for (const child of el.children) {
            if (t.isJSXElement(child) && jsxName(child) === "Route")
                visitRouteJsx(child, routePath, chain);
        }
    };

    // Top-down walk: the first route-shaped node on a branch is a root; the
    // visitors own its subtree, so it is not re-walked.
    const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
            for (const n of node) walk(n);
            return;
        }
        if (!isBabelNode(node)) return;
        if (t.isObjectExpression(node) && looksLikeRouteObject(node)) {
            visitRouteObject(node, "", []);
            return;
        }
        if (t.isJSXElement(node) && jsxName(node) === "Route") {
            visitRouteJsx(node, "", []);
            return;
        }
        for (const key of t.VISITOR_KEYS[node.type] ?? []) {
            walk((node as unknown as Record<string, unknown>)[key]);
        }
    };
    walk(ast.program);

    const localDeps = [
        ...Array.from(new Set(imports.values())).filter((f) => !elementFiles.has(f)),
        ...sideEffectImports,
    ];
    for (const binding of bindings) binding.localDeps = localDeps;
    return bindings;
}

function isBabelNode(value: unknown): value is t.Node {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { type?: unknown }).type === "string"
    );
}

function objectProps(obj: t.ObjectExpression): Map<string, t.Node> {
    const props = new Map<string, t.Node>();
    for (const p of obj.properties) {
        if (!t.isObjectProperty(p)) continue;
        const name = t.isIdentifier(p.key)
            ? p.key.name
            : t.isStringLiteral(p.key)
              ? p.key.value
              : null;
        if (name) props.set(name, p.value);
    }
    return props;
}

function looksLikeRouteObject(obj: t.ObjectExpression): boolean {
    const keys = objectProps(obj);
    return (
        (keys.has("path") || keys.has("children")) &&
        (keys.has("path") || keys.has("element") || keys.has("Component"))
    );
}

function elementName(node: t.Node | undefined): string | null {
    return t.isJSXElement(node) ? jsxName(node) : null;
}

function jsxName(el: t.JSXElement): string | null {
    const name = el.openingElement.name;
    return t.isJSXIdentifier(name) ? name.name : null;
}

function identifierName(node: t.Node | undefined): string | null {
    return t.isIdentifier(node) ? node.name : null;
}

function joinRoutePath(parent: string, child: string): string {
    const joined = child.startsWith("/") ? child : `${parent.replace(/\/$/, "")}/${child}`;
    const normalized = joined.replace(/\/+/g, "/").replace(/\/:[^/]+/g, "/[param]");
    return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized || "/";
}

function resolveImport(fromFile: string, specifier: string): string | null {
    if (!specifier.startsWith(".")) return null;
    const base = path.resolve(path.dirname(fromFile), specifier);
    const candidates = [
        base,
        ...[".tsx", ".ts", ".jsx", ".js"].map((ext) => base + ext),
        ...[".tsx", ".ts", ".jsx", ".js"].map((ext) => path.join(base, `index${ext}`)),
    ];
    for (const candidate of candidates) {
        try {
            if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
            // try the next candidate
        }
    }
    return null;
}

function walkSourceFiles(root: string): string[] {
    const out: string[] = [];
    const stack = [root];
    while (stack.length > 0 && out.length < MAX_FILES) {
        const dir = stack.pop() as string;
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

// ==========================================================================
// The code graph: graft's wiring.json, reduced to file-level reverse edges
// ==========================================================================

export interface DependentsGraph {
    /** Absolute root the graph's repo-relative paths resolve against. */
    root: string;
    /** file → files that import, call, or reference something in it. */
    dependents: Map<string, Set<string>>;
    /** Every file the graph indexed. */
    indexed: Set<string>;
}

interface WiringJson {
    nodes: Array<{ id: string; path: string; kind: string }>;
    edges: Array<{ source: string; target: string; relation: string }>;
}

/** Nearest ancestor of `from` holding a graft graph. */
export function findGraftRoot(from: string): string | null {
    let dir = path.resolve(from);
    for (;;) {
        if (fs.existsSync(path.join(dir, "graft", ".graph", "wiring.json"))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

/**
 * Load the dependents graph, refreshing it first so it describes the working
 * tree (graft rebuilds incrementally, ~1s, no model). Returns null when graft
 * is unavailable — callers fall back to name-based scoping.
 */
export function loadDependentsGraph(
    projectPath: string,
    options: { refresh?: boolean } = {},
): DependentsGraph | null {
    const root = findGraftRoot(projectPath);
    if (!root) return null;
    if (options.refresh !== false) {
        try {
            execFileSync("graft", ["build", root], {
                cwd: root,
                stdio: "ignore",
                timeout: 120_000,
                // Raiken is local-first: never let the graph step phone home.
                env: { ...process.env, DO_NOT_TRACK: "1", GRAFT_NO_STATUSLINE: "1" },
            });
        } catch {
            // graft missing or the refresh failed: a stale graph is still far
            // better evidence than file names, so read what is on disk.
        }
    }
    let wiring: WiringJson;
    try {
        wiring = JSON.parse(
            fs.readFileSync(path.join(root, "graft", ".graph", "wiring.json"), "utf-8"),
        );
    } catch {
        return null;
    }
    return dependentsFromWiring(root, wiring);
}

export function dependentsFromWiring(root: string, wiring: WiringJson): DependentsGraph {
    const pathOf = new Map<string, string>();
    const indexed = new Set<string>();
    for (const node of wiring.nodes) {
        const abs = path.join(root, node.path);
        pathOf.set(node.id, abs);
        indexed.add(abs);
    }
    const dependents = new Map<string, Set<string>>();
    for (const edge of wiring.edges) {
        if (edge.relation === "contains") continue;
        const from = pathOf.get(edge.source);
        const to = pathOf.get(edge.target);
        if (!from || !to || from === to) continue; // unresolved module, or intra-file
        let set = dependents.get(to);
        if (!set) {
            set = new Set();
            dependents.set(to, set);
        }
        set.add(from);
    }
    return { root, dependents, indexed };
}

// ==========================================================================
// The scoper
// ==========================================================================

/** Files whose change can affect behavior everywhere (config/markup/styles). */
const GLOBAL_BASENAMES = new Set([
    "index.html",
    "package.json",
    "playwright.config.ts",
    "raiken.config.json",
    "vite.config.ts",
    "next.config.js",
    "next.config.mjs",
    "tsconfig.json",
]);
const CODE_FILE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte)$/i;
const TEST_FILE = /(\.(spec|test)\.[cm]?[jt]sx?$)|(^|\/)(e2e|tests?|__tests__)\//i;

export interface ImpactScope {
    scoped: BehaviorFact[];
    /** True when the whole contract is in scope (and why, in `reasons`). */
    global: boolean;
    /** factKey → the route and the dependency path that put it in scope. */
    reasons: Map<string, string>;
    /** Why the scope widened to everything, when it did. */
    globalReason: string | null;
    /** Changed code files that reach no route (they force a global scope). */
    unmapped: string[];
}

export function scopeFactsByImpact(input: {
    projectPath: string;
    facts: BehaviorFact[];
    /** Changed files, relative to projectPath (as `git diff --name-only`). */
    changedFiles: string[];
    bindings: RouteBinding[];
    graph: DependentsGraph;
}): ImpactScope {
    const { projectPath, facts, bindings, graph } = input;
    const reasons = new Map<string, string>();
    const everything = (why: string): ImpactScope => {
        for (const f of facts) reasons.set(f.factKey, why);
        return { scoped: facts, global: true, reasons, globalReason: why, unmapped: [] };
    };

    const changed = input.changedFiles
        .map((f) => path.resolve(projectPath, f))
        .filter((f) => f.startsWith(projectPath + path.sep) || f === projectPath);
    if (changed.length === 0)
        return { scoped: [], global: false, reasons, globalReason: null, unmapped: [] };

    const globalFile = changed.find((f) => {
        const base = path.basename(f);
        return GLOBAL_BASENAMES.has(base) || /\.(css|scss|sass|less)$/i.test(base);
    });
    if (globalFile)
        return everything(`${rel(projectPath, globalFile)} changed (affects every page)`);

    // Route pattern → the route-level explanation for each changed file.
    const routeHits = new Map<string, string>();
    const unmapped: string[] = [];

    for (const file of changed) {
        if (!CODE_FILE.test(file) || TEST_FILE.test(rel(projectPath, file))) continue;
        if (!graph.indexed.has(file) && fs.existsSync(file)) {
            // A code file the graph has never seen cannot be traced: fail safe.
            unmapped.push(file);
            continue;
        }
        const trail = reverseReach(graph, file);
        let hit = false;
        for (const binding of bindings) {
            const via = explainBinding(binding, file, trail);
            if (!via) continue;
            hit = true;
            if (!routeHits.has(binding.path)) {
                routeHits.set(
                    binding.path,
                    `${binding.path} ← ${via.map((f) => rel(projectPath, f)).join(" ← ")}`,
                );
            }
        }
        if (!hit) unmapped.push(file);
    }

    if (unmapped.length > 0) {
        return {
            ...everything(
                `${unmapped.map((f) => rel(projectPath, f)).join(", ")} reaches no known route`,
            ),
            unmapped: unmapped.map((f) => rel(projectPath, f)),
        };
    }

    const scoped: BehaviorFact[] = [];
    for (const fact of facts) {
        const pattern = Array.from(routeHits.keys()).find((p) =>
            routeMatches(p, factPath(fact.route)),
        );
        if (!pattern) continue;
        scoped.push(fact);
        reasons.set(fact.factKey, routeHits.get(pattern) as string);
    }
    return { scoped, global: false, reasons, globalReason: null, unmapped: [] };
}

/** BFS over reverse edges; returns file → predecessor toward the changed file. */
function reverseReach(graph: DependentsGraph, start: string): Map<string, string | null> {
    const parent = new Map<string, string | null>([[start, null]]);
    const queue = [start];
    while (queue.length > 0) {
        const current = queue.shift() as string;
        for (const dependent of graph.dependents.get(current) ?? []) {
            if (parent.has(dependent)) continue;
            parent.set(dependent, current);
            queue.push(dependent);
        }
    }
    return parent;
}

/** The dependency path from a route's component back to the changed file, if any. */
function explainBinding(
    binding: RouteBinding,
    changedFile: string,
    trail: Map<string, string | null>,
): string[] | null {
    const pathTo = (file: string): string[] => {
        const out: string[] = [];
        let cur: string | null | undefined = file;
        while (cur) {
            out.push(cur);
            cur = trail.get(cur);
        }
        return out;
    };
    // The router file itself changed: every route it declares is in play.
    if (changedFile === binding.routeFile) return [binding.routeFile];
    for (const ref of binding.chain) {
        if (ref.kind === "file" && trail.has(ref.file)) return pathTo(ref.file);
    }
    // Local layouts render the router file's non-route imports; reaching the
    // router file only through a route element does NOT count (the router
    // imports every page, so that would put every route in scope).
    if (binding.chain.some((ref) => ref.kind === "local")) {
        for (const dep of binding.localDeps) {
            if (trail.has(dep)) return [binding.routeFile, ...pathTo(dep)];
        }
    }
    return null;
}

/** Fact routes are stored as URLs or paths; compare on the pathname. */
function factPath(route: string): string {
    try {
        if (/^https?:\/\//i.test(route)) return new URL(route).pathname.replace(/\/$/, "") || "/";
    } catch {
        // fall through to path handling
    }
    const p = route.split(/[?#]/)[0];
    return (p.startsWith("/") ? p : `/${p}`).replace(/\/$/, "") || "/";
}

function routeMatches(pattern: string, pathname: string): boolean {
    const re = new RegExp(
        `^${pattern
            .split("/")
            .map((seg) =>
                seg === "[param]" || /^\[.+\]$/.test(seg)
                    ? "[^/]+"
                    : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            )
            .join("/")}$`,
    );
    return re.test(pathname);
}

function rel(root: string, file: string): string {
    return path.relative(root, file).split(path.sep).join("/");
}
