import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodeGraph } from "../analysis/code-graph";
import {
    CodeGraphUnavailableError,
    GraftIndex,
    type GraftWiring,
    graftDirFor,
} from "../analysis/graft";
import { GraphQueryService } from "../analysis/graph-query";
import { CodeGraphDB } from "../database/db";

function write(root: string, files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content);
    }
}

describe("GraftIndex (wiring.json → Raiken graph)", () => {
    const root = path.resolve("/repo");
    const wiring: GraftWiring = {
        meta: { version: 1 },
        nodes: [
            {
                id: "src/a.tsx",
                name: "a.tsx",
                kind: "file",
                path: "src/a.tsx",
                span: "L1-L20",
                signature: null,
                exported: true,
            },
            {
                id: "src/a.tsx#Page",
                name: "Page",
                kind: "function",
                path: "src/a.tsx",
                span: "L3-L9",
                signature: "export async function Page()",
                exported: true,
            },
            {
                id: "src/b.tsx",
                name: "b.tsx",
                kind: "file",
                path: "src/b.tsx",
                span: "L1-L9",
                signature: null,
                exported: true,
            },
            {
                id: "src/b.tsx#Button",
                name: "Button",
                kind: "function",
                path: "src/b.tsx",
                span: "L1-L4",
                signature: "function Button()",
                exported: true,
            },
            {
                id: "src/b.tsx#format",
                name: "format",
                kind: "function",
                path: "src/b.tsx",
                span: "L6-L8",
                signature: "function format(x: number)",
                exported: true,
            },
            {
                id: "src/b.tsx#Store",
                name: "Store",
                kind: "class",
                path: "src/b.tsx",
                span: "L10-L20",
                signature: "class Store",
                exported: true,
            },
            {
                id: "src/b.tsx#Store.get",
                name: "get",
                kind: "method",
                owner: "Store",
                path: "src/b.tsx",
                span: "L11-L12",
                signature: "get()",
                exported: false,
            },
            {
                id: "src/b.tsx#VERSION",
                name: "VERSION",
                kind: "constant",
                path: "src/b.tsx",
                span: "L22",
                signature: null,
                exported: true,
            },
        ],
        edges: [
            {
                source: "src/a.tsx",
                target: "src/b.tsx",
                relation: "imports",
                confidence: "extracted",
            },
            {
                source: "src/a.tsx",
                target: "@/lib/api",
                relation: "imports",
                confidence: "extracted",
            },
            { source: "src/a.tsx", target: "react", relation: "imports", confidence: "extracted" },
            {
                source: "src/a.tsx#Page",
                target: "src/b.tsx#format",
                relation: "calls",
                confidence: "inferred",
            },
            {
                source: "src/a.tsx#Page",
                target: "src/b.tsx#Button",
                relation: "references",
                confidence: "extracted",
            },
            {
                source: "src/b.tsx",
                target: "src/b.tsx#Button",
                relation: "contains",
                confidence: "extracted",
            },
        ],
    };
    const index = new GraftIndex(root, wiring);
    const a = path.join(root, "src/a.tsx");
    const b = path.join(root, "src/b.tsx");

    it("maps symbols, marks JSX PascalCase functions as components, drops variables", () => {
        const symbols = index.symbolsFor(b);
        expect(symbols.map((s) => [s.name, s.kind])).toEqual([
            ["Button", "component"],
            ["format", "function"],
            ["Store", "class"],
            ["get", "method"],
        ]);
        expect(symbols.find((s) => s.name === "get")?.parent).toBe("Store");
        expect(index.symbolsFor(a)[0]).toMatchObject({
            name: "Page",
            startLine: 3,
            endLine: 9,
            isAsync: true,
        });
    });

    it("splits resolved imports from specifiers graft could not resolve", () => {
        expect(index.importsFor(a)).toEqual([b]);
        expect(index.unresolvedImportsFor(a).sort()).toEqual(["@/lib/api", "react"]);
    });

    it("carries calls with graft's confidence tier and references as weaker renders", () => {
        const edges = index.edgesFor(a);
        expect(edges).toContainEqual(
            expect.objectContaining({
                kind: "calls",
                sourceSymbol: "Page",
                targetSymbol: "format",
                targetFile: b,
                confidence: 0.7,
            }),
        );
        const render = edges.find((e) => e.kind === "renders");
        expect(render).toMatchObject({
            sourceSymbol: "Page",
            targetSymbol: "Button",
            targetFile: b,
        });
        expect(render?.confidence).toBeCloseTo(0.63);
    });

    it("builds file-level dependents from imports and symbol edges", () => {
        expect(Array.from(index.dependentsOf(b))).toEqual([a]);
        const lib = path.join(root, "src/lib/api.ts");
        index.addFileDependency(a, lib);
        expect(index.dependentsOf(lib).has(a)).toBe(true);
        expect(index.importsFor(a)).toContain(lib);
    });
});

describe("CodeGraph on graft (integration: the bundled graft binary)", () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raiken-graft-")));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("indexes symbols, cross-file calls, alias imports, and non-JS languages", async () => {
        write(dir, {
            "tsconfig.json": JSON.stringify({
                compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
            }),
            "src/lib/price.ts":
                "export function formatPrice(cents: number) { return `$${cents / 100}`; }\n",
            "src/components/Badge.tsx":
                'export function Badge() { return <span data-testid="badge" />; }\n',
            "src/pages/Cart.tsx": [
                'import { formatPrice } from "../lib/price";',
                'import { Badge } from "@/components/Badge";',
                "export function Cart() {",
                "    const total = formatPrice(1200);",
                "    return <div>{total}<Badge /></div>;",
                "}",
                "",
            ].join("\n"),
            "server/pricing.py": "def discount(total):\n    return total * 0.9\n",
        });

        const graph = new CodeGraph(dir);
        await graph.scanProject();
        expect(graph.getGraphStatus()).toEqual({ available: true });

        const cart = graph.getNode(path.join(dir, "src/pages/Cart.tsx"));
        expect(cart?.symbols?.map((s) => [s.name, s.kind])).toEqual([["Cart", "component"]]);
        expect(cart?.edges).toContainEqual(
            expect.objectContaining({
                kind: "calls",
                sourceSymbol: "Cart",
                targetSymbol: "formatPrice",
                targetFile: path.join(dir, "src/lib/price.ts"),
            }),
        );
        // Relative import from graft, alias import resolved by Raiken on top.
        expect(cart?.imports.sort()).toEqual(
            [path.join(dir, "src/components/Badge.tsx"), path.join(dir, "src/lib/price.ts")].sort(),
        );
        // Raiken's own pass still runs on JS/TS: the Babel outline and AST
        // (keyword search, agent context) sit alongside graft's symbols.
        const badge = graph.getNode(path.join(dir, "src/components/Badge.tsx"));
        expect(badge?.parsed.functions.map((f) => f.name)).toEqual(["Badge"]);
        expect(badge?.ast).toBeDefined();
        expect(cart?.parsed.imports.map((i) => i.source).sort()).toEqual([
            "../lib/price",
            "@/components/Badge",
        ]);

        const py = graph.getNode(path.join(dir, "server/pricing.py"));
        expect(py?.symbols?.map((s) => s.name)).toEqual(["discount"]);
        expect(py?.parsed.functions.map((f) => f.name)).toEqual(["discount"]);

        // The graph lives under .raiken/ and graft leaves the user's tree alone.
        expect(fs.existsSync(path.join(graftDirFor(dir), ".graph", "wiring.json"))).toBe(true);
        expect(fs.existsSync(path.join(dir, "graft"))).toBe(false);
        expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
        expect(fs.existsSync(path.join(dir, ".ignore"))).toBe(false);
    }, 60_000);

    it("persists graft edges so affected-test queries see symbol-level calls", async () => {
        write(dir, {
            "src/lib/price.ts":
                "export function formatPrice(cents: number) { return cents / 100; }\n",
            "tests/price.spec.ts": [
                'import { formatPrice } from "../src/lib/price";',
                "export function checksPrice() { return formatPrice(100) === 1; }",
                "",
            ].join("\n"),
        });
        const graph = new CodeGraph(dir);
        await graph.scanProject();
        const db = new CodeGraphDB(dir);
        try {
            const nodes = new Map(graph.getAllFiles().map((n) => [n.filePath, n]));
            db.saveGraph(nodes, []);
        } finally {
            db.close();
        }

        const affected = new GraphQueryService(dir).getAffectedTests([
            path.join(dir, "src/lib/price.ts"),
        ]);
        expect(affected).toHaveLength(1);
        expect(affected[0].testFile).toBe(path.join(dir, "tests/price.spec.ts"));
        expect(affected[0].reasons.map((r) => r.reason).sort()).toEqual(["calls", "imports"]);
    }, 60_000);

    it("degrades loudly when the graph is unavailable: files still index, no symbols or edges", async () => {
        write(dir, {
            "src/a.ts": 'import { b } from "./b";\nexport const a = b;\n',
            "src/b.ts": "export const b = 1;\n",
        });
        const graph = new CodeGraph(dir, {
            loadGraph: () =>
                Promise.reject(
                    new CodeGraphUnavailableError(
                        "the tree-sitter-kotlin parser has no prebuilt binary",
                    ),
                ),
        });
        await graph.scanProject();

        expect(graph.getGraphStatus()).toEqual({
            available: false,
            reason: "the tree-sitter-kotlin parser has no prebuilt binary",
        });
        const a = graph.getNode(path.join(dir, "src/a.ts"));
        expect(a).toBeDefined();
        expect(a?.symbols).toEqual([]);
        expect(a?.edges).toEqual([]);
        expect(a?.parsed.imports.map((i) => i.source)).toEqual(["./b"]);
    });

    it("re-reads the graph when a watched file changes", async () => {
        write(dir, {
            "src/a.ts": "export function a() { return 1; }\n",
            "src/b.ts": "export function b() { return 2; }\n",
        });
        const graph = new CodeGraph(dir);
        await graph.scanProject();
        expect(graph.getNode(path.join(dir, "src/a.ts"))?.edges).toEqual([]);

        fs.writeFileSync(
            path.join(dir, "src/a.ts"),
            'import { b } from "./b";\nexport function a() { return b(); }\n',
        );
        await graph.updateFile(path.join(dir, "src/a.ts"));

        const a = graph.getNode(path.join(dir, "src/a.ts"));
        expect(a?.imports).toEqual([path.join(dir, "src/b.ts")]);
        expect(a?.edges).toContainEqual(
            expect.objectContaining({ kind: "calls", sourceSymbol: "a", targetSymbol: "b" }),
        );
    }, 60_000);
});
