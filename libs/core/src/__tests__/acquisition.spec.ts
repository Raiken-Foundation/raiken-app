import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractSourceRoutes } from "../contract/routes";
import { mergeKnownRoutes, resolveRouteUrl } from "../contract/snapshotter";
import { parsePlan, DESTRUCTIVE_LABEL } from "../contract/explore";

describe("source route extraction", () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raiken-routes-")));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("extracts Next.js app-dir routes with dynamic segments and route groups", () => {
        fs.mkdirSync(path.join(dir, "app", "checkout"), { recursive: true });
        fs.mkdirSync(path.join(dir, "app", "(marketing)", "about"), { recursive: true });
        fs.mkdirSync(path.join(dir, "app", "users", "[id]"), { recursive: true });
        fs.writeFileSync(path.join(dir, "app", "page.tsx"), "export default function Home() {}");
        fs.writeFileSync(path.join(dir, "app", "checkout", "page.tsx"), "export default function C() {}");
        fs.writeFileSync(path.join(dir, "app", "(marketing)", "about", "page.tsx"), "x");
        fs.writeFileSync(path.join(dir, "app", "users", "[id]", "page.tsx"), "x");

        const routes = extractSourceRoutes(dir);
        const paths = routes.map((r) => r.path);
        expect(paths).toContain("/");
        expect(paths).toContain("/checkout");
        expect(paths).toContain("/about");
        expect(paths).toContain("/users/[id]");
        const dynamic = routes.find((r) => r.path === "/users/[id]");
        expect(dynamic?.dynamic).toBe(true);
        expect(routes.every((r) => r.source === "next-app")).toBe(true);
    });

    it("extracts React Router path tables and JSX routes", () => {
        fs.mkdirSync(path.join(dir, "src"), { recursive: true });
        fs.writeFileSync(
            path.join(dir, "src", "router.tsx"),
            `import { createBrowserRouter } from "react-router-dom";
export const router = createBrowserRouter([
  { path: "/", element: <Home /> },
  { path: "/checkout", element: <Checkout /> },
  { path: "/users/:id", element: <Profile /> },
]);
export function More() {
  return <Routes><Route path="/settings" element={<S />} /></Routes>;
}`,
        );
        const routes = extractSourceRoutes(dir);
        const paths = routes.map((r) => r.path);
        expect(paths).toContain("/checkout");
        expect(paths).toContain("/users/[param]");
        expect(paths).toContain("/settings");
        expect(routes.every((r) => r.source === "react-router")).toBe(true);
    });

    it("finds nothing in an empty project", () => {
        expect(extractSourceRoutes(dir)).toEqual([]);
    });
});

describe("route merging + resolution", () => {
    it("merges source routes with discovered hash routes without duplicates", () => {
        const merged = mergeKnownRoutes(
            [
                { path: "/", sourceFile: "app/page.tsx", source: "next-app", dynamic: false },
                { path: "/checkout", sourceFile: "app/checkout/page.tsx", source: "next-app", dynamic: false },
            ],
            ["http://localhost:9300/", "http://localhost:9300/#/shop", "http://localhost:9300/#/cart"],
            "http://localhost:9300",
        );
        const paths = merged.map((r) => r.path);
        expect(paths).toEqual(["/", "/checkout", "/#/shop", "/#/cart"]);
    });

    it("resolves route paths against baseURL", () => {
        expect(resolveRouteUrl("/checkout", "http://localhost:9300")).toBe(
            "http://localhost:9300/checkout",
        );
        expect(resolveRouteUrl("/", "http://localhost:9300/")).toBe("http://localhost:9300/");
    });
});

describe("AGENTS.md emission", () => {
    it("builds the section with coverage and never-regress risk", async () => {
        const { buildAgentsSection } = await import("../contract/agents-md");
        const section = buildAgentsSection({
            projectPath: "/x",
            observed: [],
            intent: [
                {
                    requirementKey: "k",
                    requirementText: "login must never regress",
                    routeHint: null,
                    ticketId: null,
                    ticketProvider: null,
                    ticketSeverity: null,
                    ticketUrl: null,
                    neverRegress: true,
                    status: "uncovered",
                    matchedFactId: null,
                    source: "file",
                    importedAt: 1,
                },
            ],
            coverage: { total: 3, covered: 2, uncovered: 1, violated: 0, neverRegressUncovered: 1, entries: [], computedAt: 1 },
            exportedAt: 1,
        });
        expect(section).toContain("2/3 covered");
        expect(section).toContain("login must never regress");
        expect(section).toContain("raiken contract verify");
    });

    it("appends and then refreshes the section idempotently", async () => {
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raiken-agents-")));
        try {
            const { emitAgentsSection } = await import("../contract/agents-md");
            const file = path.join(dir, "AGENTS.md");
            fs.writeFileSync(file, "# Existing\n\nSome content.\n");
            const view = { projectPath: dir, observed: [], intent: [], coverage: null, exportedAt: 1 };
            const first = emitAgentsSection(dir, view);
            expect(first.created).toBe(true);
            const after = fs.readFileSync(file, "utf-8");
            expect(after).toContain("# Existing");
            expect(after).toContain("Behavior Contract");
            const second = emitAgentsSection(dir, view);
            expect(second.refreshed).toBe(true);
            // Refreshed file still has exactly one marker pair.
            const matches = fs.readFileSync(file, "utf-8").match(/raiken-contract/g);
            expect(matches).toHaveLength(2);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("exploration plans", () => {
    it("parses a JSON plan out of prose-surrounded reasoning output", () => {
        const plan = parsePlan(
            'Thinking through the flow... {"steps":[{"action":"goto","target":"#/shop"},{"action":"click","target":"Add to cart"},{"action":"observe","target":"Cart 1"}]} trailing words',
        );
        expect(plan?.steps).toHaveLength(3);
        expect(plan?.steps[1]).toEqual({ action: "click", target: "Add to cart", value: undefined });
    });

    it("rejects non-JSON and empty-step plans", () => {
        expect(parsePlan("no json here")).toBeNull();
        expect(parsePlan('{"steps":[]}')).toBeNull();
        expect(parsePlan('{"steps":[{"action":"explode","target":"x"}]}')).toBeNull();
    });

    it("blocks destructive labels", () => {
        for (const label of ["Delete account", "Sign out", "Remove item", "Archive project", "Place order", "Reset password"]) {
            expect(DESTRUCTIVE_LABEL.test(label), label).toBe(true);
        }
        expect(DESTRUCTIVE_LABEL.test("Add to cart")).toBe(false);
        expect(DESTRUCTIVE_LABEL.test("Next: payment →")).toBe(false);
    });
});
