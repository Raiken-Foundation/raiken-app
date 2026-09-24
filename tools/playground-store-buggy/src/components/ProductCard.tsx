import { Link } from "react-router-dom";
import type { Product } from "../types";

export function formatPrice(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
}

export function ProductCard({ product }: { product: Product }) {
    const soldOut = product.stock === 0;
    return (
        <Link
            to={`/product/${product.slug}`}
            className={`card product-card ${soldOut ? "product-card-soldout" : ""}`}
            data-testid={`product-${product.slug}`}
        >
            <header className="product-card-header">
                <h3>{product.name}</h3>
                <span className="product-price" data-testid={`price-${product.slug}`}>
                    {formatPrice(product.priceCents)}
                </span>
            </header>
            <p className="muted product-card-description">{product.description}</p>
            <footer className="product-card-footer">
                <span className="muted">{product.category}</span>
                {soldOut ? (
                    <span className="pill pill-soldout" data-testid={`stock-${product.slug}`}>
                        Out of stock
                    </span>
                ) : (
                    <span className="pill pill-instock" data-testid={`stock-${product.slug}`}>
                        {product.stock} in stock
                    </span>
                )}
            </footer>
        </Link>
    );
}
