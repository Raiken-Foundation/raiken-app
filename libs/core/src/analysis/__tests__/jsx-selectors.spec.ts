import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../ast-parser";

describe("parseSourceFile JSX selector extraction", () => {
    it("extracts literal data-testid, aria-label, placeholder, and role from JSX", () => {
        const code = `
export function Card({ title }: { title: string }) {
    return (
        <article data-testid="card-row" aria-label="Card" role="article">
            <input placeholder="Search…" aria-label="Search input" />
            <button role="button" data-testid="card-delete">Delete</button>
        </article>
    );
}
`;
        const { parsed } = parseSourceFile(code, "Card.tsx");
        const selectors = parsed.templateSelectors ?? [];

        const ids = selectors.filter((s) => s.kind === "testId").map((s) => s.value);
        expect(ids).toContain("card-row");
        expect(ids).toContain("card-delete");
        expect(selectors.some((s) => s.kind === "label" && s.value === "Search input")).toBe(true);
        expect(selectors.some((s) => s.kind === "placeholder" && s.value === "Search…")).toBe(true);
        expect(selectors.some((s) => s.kind === "role" && s.value === "article")).toBe(true);
    });

    it("skips dynamic (expression) attribute values", () => {
        const code = `
export function Row({ id }: { id: string }) {
    return <div data-testid={id} aria-label={\`row-\${id}\`} />;
}
`;
        const { parsed } = parseSourceFile(code, "Row.tsx");
        expect(parsed.templateSelectors ?? []).toEqual([]);
    });

    it("accepts a string-literal JSX expression container", () => {
        const code = `export const B = () => <div data-testid={"static-id"} />;`;
        const { parsed } = parseSourceFile(code, "B.tsx");
        const ids = (parsed.templateSelectors ?? [])
            .filter((s) => s.kind === "testId")
            .map((s) => s.value);
        expect(ids).toContain("static-id");
    });
});

describe("parseSourceFile route extraction", () => {
    it("extracts literal <Route path> strings", () => {
        const code = `
import { Routes, Route } from "react-router-dom";
export default function App() {
    return (
        <Routes>
            <Route path="/" element={<Catalog />} />
            <Route path="/product/:slug" element={<Detail />} />
            <Route path="/cart" element={<Cart />} />
        </Routes>
    );
}
`;
        const { parsed } = parseSourceFile(code, "App.tsx");
        expect(parsed.routes).toEqual(["/", "/product/:slug", "/cart"]);
    });

    it("skips dynamic path expressions and non-Route elements", () => {
        const code = `
import { Route, Link } from "react-router-dom";
export const App = () => (
    <>
        <Route path={getPath()} element={<X />} />
        <Link to="/about">About</Link>
    </>
);
`;
        const { parsed } = parseSourceFile(code, "App.tsx");
        expect(parsed.routes ?? []).toEqual([]);
    });
});
