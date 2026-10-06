import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraftIndex } from "../analysis/graft";
import {
    type DependentsGraph,
    dependentsFromIndex,
    extractRouteBindings,
    scopeFactsByImpact,
} from "../contract/impact";
import type { BehaviorFact } from "../contract/types";
import { scopeFactsByChanges } from "../contract/verify";

const ROUTER = `
import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";
import ProtectedLayout from "./auth/ProtectedLayout";
import CookieConsent from "./components/CookieConsent";
import Login from "./pages/Login";
import Settings from "./pages/Settings";
import Tasks from "./pages/Tasks";
import ProjectDetail from "./pages/ProjectDetail";

function RootLayout() {
    return (<><CookieConsent /><Outlet /></>);
}

export const router = createBrowserRouter([
    {
        element: <RootLayout />,
        children: [
            { path: "/auth/login", element: <Login /> },
            {
                element: <ProtectedLayout />,
                children: [
                    { path: "/", element: <Navigate to="/tasks" replace /> },
                    { path: "/tasks", element: <Tasks /> },
                    { path: "/settings", element: <Settings /> },
                    { path: "/projects/:id", element: <ProjectDetail /> },
                ],
            },
        ],
    },
]);
`;

const FILES: Record<string, string> = {
    "src/main.tsx": ROUTER,
    "src/auth/ProtectedLayout.tsx": "export default function ProtectedLayout() { return null; }",
    "src/auth/useSession.ts": "export function useSession() { return null; }",
    "src/components/CookieConsent.tsx": "export default function CookieConsent() { return null; }",
    "src/components/ConfirmDialog.tsx": "export default function ConfirmDialog() { return null; }",
    "src/pages/Login.tsx": "export default function Login() { return null; }",
    "src/pages/Settings.tsx": "export default function Settings() { return null; }",
    "src/pages/Tasks.tsx": "export default function Tasks() { return null; }",
    "src/pages/ProjectDetail.tsx": "export default function ProjectDetail() { return null; }",
    "src/api/server.ts": "export function handler() {}",
};

/** file → files it imports (repo-relative); mirrors what graft records. */
const IMPORTS: Record<string, string[]> = {
    "src/main.tsx": [
        "src/auth/ProtectedLayout.tsx",
        "src/components/CookieConsent.tsx",
        "src/pages/Login.tsx",
        "src/pages/Settings.tsx",
        "src/pages/Tasks.tsx",
        "src/pages/ProjectDetail.tsx",
    ],
    "src/auth/ProtectedLayout.tsx": ["src/auth/useSession.ts"],
    "src/pages/Settings.tsx": ["src/components/ConfirmDialog.tsx", "src/auth/useSession.ts"],
};

function fact(route: string): BehaviorFact {
    return {
        factKey: route,
        route: `http://127.0.0.1:5100${route}`,
        precondition: null,
        action: `open ${route}`,
        expectedObservable: `shows heading "${route}"`,
        status: "verified",
        evidence: null,
        sourceCommit: null,
        capturedAt: 0,
        lastVerifiedAt: null,
        verifiedCount: 0,
        violatedCount: 0,
        confidence: 1,
    };
}

describe("contract impact scoping", () => {
    let dir: string;
    let graph: DependentsGraph;
    const facts = ["/auth/login", "/tasks", "/settings", "/projects/42"].map(fact);

    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raiken-impact-")));
        for (const [rel, content] of Object.entries(FILES)) {
            fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
            fs.writeFileSync(path.join(dir, rel), content);
        }
        graph = dependentsFromIndex(
            new GraftIndex(dir, {
                nodes: Object.keys(FILES).map((rel) => ({
                    id: rel,
                    name: path.basename(rel),
                    kind: "file",
                    path: rel,
                    span: "L1-L1",
                    signature: null,
                    exported: true,
                })),
                edges: Object.entries(IMPORTS).flatMap(([source, targets]) =>
                    targets.map((target) => ({
                        source,
                        target,
                        relation: "imports",
                        confidence: "extracted",
                    })),
                ),
            }),
        );
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const scope = (changed: string[]) =>
        scopeFactsByImpact({
            projectPath: dir,
            facts,
            changedFiles: changed,
            bindings: extractRouteBindings(dir),
            graph,
        });

    it("maps React Router routes to their layout chain", () => {
        const bindings = extractRouteBindings(dir);
        const tasks = bindings.find((b) => b.path === "/tasks");
        expect(tasks?.chain).toEqual([
            { kind: "local", name: "RootLayout" },
            { kind: "file", file: path.join(dir, "src/auth/ProtectedLayout.tsx") },
            { kind: "file", file: path.join(dir, "src/pages/Tasks.tsx") },
        ]);
        expect(bindings.map((b) => b.path)).toContain("/projects/[param]");
        expect(tasks?.localDeps).toEqual([path.join(dir, "src/components/CookieConsent.tsx")]);
    });

    it("reaches a page through a shared component, with the path as the reason", () => {
        const result = scope(["src/components/ConfirmDialog.tsx"]);
        expect(result.global).toBe(false);
        expect(result.scoped.map((f) => f.factKey)).toEqual(["/settings"]);
        expect(result.reasons.get("/settings")).toBe(
            "/settings ← src/pages/Settings.tsx ← src/components/ConfirmDialog.tsx",
        );
    });

    it("scopes a directly edited page that name matching misses", () => {
        // Regression: name matching drops short tokens like "tasks".
        expect(scopeFactsByChanges(facts, ["src/pages/Tasks.tsx"]).scoped).toEqual([]);
        expect(scope(["src/pages/Tasks.tsx"]).scoped.map((f) => f.factKey)).toEqual(["/tasks"]);
    });

    it("a layout dependency reaches every route under that layout, not the public ones", () => {
        const scoped = scope(["src/auth/useSession.ts"]).scoped.map((f) => f.factKey);
        expect(scoped.sort()).toEqual(["/projects/42", "/settings", "/tasks"]);
    });

    it("a dependency of a local layout in the router file reaches every route it wraps", () => {
        const scoped = scope(["src/components/CookieConsent.tsx"]).scoped.map((f) => f.factKey);
        expect(scoped).toHaveLength(facts.length);
    });

    it("reaching the router file only through a page does not widen to every route", () => {
        // main.tsx imports every page, so it is a dependent of ConfirmDialog too.
        expect(scope(["src/components/ConfirmDialog.tsx"]).scoped).toHaveLength(1);
    });

    it("fails safe: a code change that reaches no route verifies the whole contract", () => {
        const result = scope(["src/api/server.ts"]);
        expect(result.global).toBe(true);
        expect(result.unmapped).toEqual(["src/api/server.ts"]);
        expect(result.scoped).toHaveLength(facts.length);
    });

    it("fails safe on code the graph never indexed", () => {
        fs.writeFileSync(path.join(dir, "src/new-module.ts"), "export const x = 1;");
        expect(scope(["src/new-module.ts"]).global).toBe(true);
    });

    it("styles and config widen to everything; docs and tests reach nothing", () => {
        expect(scope(["src/styles.css"]).global).toBe(true);
        expect(scope(["package.json"]).global).toBe(true);
        expect(scope(["README.md"]).scoped).toEqual([]);
        expect(scope(["src/pages/Tasks.spec.tsx"]).scoped).toEqual([]);
    });

    it("maps Next.js app-dir pages with their layouts", () => {
        const next = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raiken-impact-next-")));
        try {
            for (const rel of [
                "app/layout.tsx",
                "app/(shop)/cart/layout.tsx",
                "app/(shop)/cart/page.tsx",
            ]) {
                fs.mkdirSync(path.dirname(path.join(next, rel)), { recursive: true });
                fs.writeFileSync(
                    path.join(next, rel),
                    "export default function X() { return null; }",
                );
            }
            const [cart] = extractRouteBindings(next);
            expect(cart.path).toBe("/cart");
            expect(
                cart.chain.map((c) => (c.kind === "file" ? path.relative(next, c.file) : c.name)),
            ).toEqual(["app/layout.tsx", "app/(shop)/cart/layout.tsx", "app/(shop)/cart/page.tsx"]);
        } finally {
            fs.rmSync(next, { recursive: true, force: true });
        }
    });
});
