import { useMemo, useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { ProductCard } from "../components/ProductCard";
import { SearchInput } from "../components/SearchInput";
import { useCart } from "../contexts/CartContext";
import type { ProductCategory } from "../types";

type SortKey = "featured" | "price-asc" | "price-desc" | "name";

const CATEGORIES: Array<{ id: ProductCategory | "all"; label: string }> = [
    { id: "all", label: "All" },
    { id: "audio", label: "Audio" },
    { id: "input", label: "Input" },
    { id: "display", label: "Display" },
    { id: "furniture", label: "Furniture" },
];

export function CatalogPage() {
    const { products } = useCart();
    const [query, setQuery] = useState("");
    const [category, setCategory] = useState<ProductCategory | "all">("all");
    const [sort, setSort] = useState<SortKey>("featured");

    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — BUG B8 ignores the search query; the unused dep is part of the defect.
    const filtered = useMemo(() => {
        let next = products;
        // BUG B8: the search query is ignored — every product is returned.
        if (category !== "all") next = next.filter((p) => p.category === category);
        switch (sort) {
            case "price-asc":
                return [...next].sort((a, b) => a.priceCents - b.priceCents);
            case "price-desc":
                // BUG B6: high-to-low actually sorts low-to-high.
                return [...next].sort((a, b) => a.priceCents - b.priceCents);
            case "name":
                return [...next].sort((a, b) => a.name.localeCompare(b.name));
            default:
                return next;
        }
    }, [products, query, category, sort]);

    return (
        <main className="page" data-testid="catalog-page">
            <header className="page-header">
                <h1>Catalog</h1>
                <p className="muted">{filtered.length} product(s) shown.</p>
            </header>
            <div className="toolbar">
                <SearchInput
                    value={query}
                    onChange={setQuery}
                    placeholder="Search products…"
                    aria-label="Search products"
                    data-testid="catalog-search"
                />
                {/* biome-ignore lint/a11y/useSemanticElements: segmented control is a button group */}
                <div className="segmented" role="group" aria-label="Filter by category">
                    {CATEGORIES.map((item) => (
                        <button
                            key={item.id}
                            type="button"
                            className={`segment ${category === item.id ? "segment-active" : ""}`}
                            data-testid={`category-${item.id}`}
                            onClick={() => setCategory(item.id)}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>
                <select
                    className="input select-sm"
                    aria-label="Sort products"
                    value={sort}
                    data-testid="sort-select"
                    onChange={(event) => setSort(event.target.value as SortKey)}
                >
                    <option value="featured">Featured</option>
                    <option value="price-asc">Price: low to high</option>
                    <option value="price-desc">Price: high to low</option>
                    <option value="name">Name A–Z</option>
                </select>
            </div>

            {filtered.length === 0 ? (
                <EmptyState
                    title="No products match"
                    hint={query ? `Nothing matches "${query}".` : "Try another category."}
                    action={
                        <button
                            type="button"
                            className="button button-ghost"
                            data-testid="clear-filters"
                            onClick={() => {
                                setQuery("");
                                setCategory("all");
                            }}
                        >
                            Clear filters
                        </button>
                    }
                />
            ) : (
                <div className="product-grid" data-testid="product-grid">
                    {filtered.map((product) => (
                        <ProductCard key={product.id} product={product} />
                    ))}
                </div>
            )}
        </main>
    );
}
