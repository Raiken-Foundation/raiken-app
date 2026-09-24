import { Link, useParams } from "react-router-dom";
import { cartQuantity } from "../api/store";
import { formatPrice } from "../components/ProductCard";
import { Skeleton } from "../components/Skeleton";
import { useCart } from "../contexts/CartContext";
import { useToast } from "../contexts/ToastContext";

export function ProductDetailPage() {
    const { slug = "" } = useParams();
    const { products, cart, add } = useCart();
    const { push } = useToast();

    const product = products.find((p) => p.slug === slug);
    if (!product) {
        return (
            <main className="page">
                <Skeleton lines={4} />
            </main>
        );
    }

    const inCart = cartQuantity(product.id, cart);
    const soldOut = product.stock === 0;
    const remaining = product.stock - inCart;

    const handleAdd = () => {
        try {
            add(product, 1);
            push("success", `${product.name} added to cart`);
        } catch (err) {
            push("error", err instanceof Error ? err.message : "Could not add to cart.");
        }
    };

    return (
        <main className="page" data-testid="product-detail-page">
            <p>
                <Link to="/" className="link" data-testid="back-to-catalog">
                    ← Back to catalog
                </Link>
            </p>
            <section className="card product-detail" data-testid={`detail-${product.slug}`}>
                <h1 data-testid="product-name">{product.name}</h1>
                <p className="muted">{product.category}</p>
                <p className="product-detail-description" data-testid="product-description">
                    {product.description}
                </p>
                <p className="product-detail-price" data-testid="product-price">
                    {formatPrice(product.priceCents)}
                </p>
                {soldOut ? (
                    <p className="pill pill-soldout" data-testid="sold-out-note">
                        Out of stock — this product cannot be added.
                    </p>
                ) : (
                    <>
                        <p className="muted" data-testid="stock-note">
                            {remaining} left in stock
                            {inCart > 0 ? ` (${inCart} in your cart)` : ""}.
                        </p>
                        <button
                            type="button"
                            className="button button-primary"
                            data-testid="add-to-cart"
                            disabled={remaining <= 0}
                            onClick={handleAdd}
                        >
                            {remaining <= 0 ? "Nothing left to add" : "Add to cart"}
                        </button>
                    </>
                )}
            </section>
        </main>
    );
}
