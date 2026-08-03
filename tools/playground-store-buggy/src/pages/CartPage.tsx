import { useState } from "react";
import { Link } from "react-router-dom";
import { formatPrice } from "../components/ProductCard";
import { EmptyState } from "../components/EmptyState";
import { useCart } from "../contexts/CartContext";
import { useToast } from "../contexts/ToastContext";

export function CartPage() {
    const { cart, products, setQuantity, remove, applyCoupon, clearCoupon, totals, itemCount } =
        useCart();
    const { push } = useToast();
    const [couponDraft, setCouponDraft] = useState("");

    const lines = cart.lines
        .map((line) => ({ line, product: products.find((p) => p.id === line.productId) }))
        .filter((entry) => entry.product !== undefined);

    const handleCoupon = () => {
        try {
            applyCoupon(couponDraft);
            push("success", "Coupon applied");
            setCouponDraft("");
        } catch (err) {
            push("error", err instanceof Error ? err.message : "Coupon rejected.");
        }
    };

    if (lines.length === 0) {
        return (
            <main className="page" data-testid="cart-page">
                <h1>Cart</h1>
                <EmptyState
                    title="Your cart is empty"
                    hint="Browse the catalog and add something you like."
                    action={
                        <Link to="/" className="button button-primary">
                            Browse catalog
                        </Link>
                    }
                />
            </main>
        );
    }

    return (
        <main className="page" data-testid="cart-page">
            <h1>Cart</h1>
            <section className="card">
                <ul className="cart-list" data-testid="cart-list">
                    {lines.map(({ line, product }) => {
                        if (!product) return null;
                        return (
                            <li key={line.productId} className="cart-row" data-testid={`cart-${product.slug}`}>
                                <div className="cart-row-info">
                                    <Link to={`/product/${product.slug}`} className="cart-row-name">
                                        {product.name}
                                    </Link>
                                    <span className="muted">{formatPrice(product.priceCents)} each</span>
                                </div>
                                <div className="cart-row-controls">
                                    <label className="sr-only" htmlFor={`qty-${product.id}`}>
                                        Quantity for {product.name}
                                    </label>
                                    <select
                                        id={`qty-${product.id}`}
                                        className="input select-sm"
                                        value={line.quantity}
                                        aria-label={`Quantity for ${product.name}`}
                                        data-testid={`qty-${product.slug}`}
                                        onChange={(event) =>
                                            setQuantity(product.id, Number(event.target.value))
                                        }
                                    >
                                        {Array.from({ length: product.stock }, (_, i) => i + 1).map(
                                            (q) => (
                                                <option key={q} value={q}>
                                                    {q}
                                                </option>
                                            ),
                                        )}
                                    </select>
                                    <button
                                        type="button"
                                        className="button button-danger-outline button-sm"
                                        data-testid={`remove-${product.slug}`}
                                        onClick={() => {
                                            remove(product.id);
                                            push("info", `${product.name} removed from cart`);
                                        }}
                                    >
                                        Remove
                                    </button>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            </section>

            <section className="card cart-summary" data-testid="cart-summary">
                <h2>Summary</h2>
                <div className="coupon-row">
                    <input
                        className="input"
                        type="text"
                        placeholder="Coupon code (try WELCOME10)"
                        value={couponDraft}
                        aria-label="Coupon code"
                        data-testid="coupon-input"
                        onChange={(event) => setCouponDraft(event.target.value)}
                    />
                    <button
                        type="button"
                        className="button button-ghost"
                        data-testid="coupon-apply"
                        onClick={handleCoupon}
                    >
                        Apply
                    </button>
                    {cart.coupon ? (
                        <button
                            type="button"
                            className="button button-ghost button-sm"
                            data-testid="coupon-clear"
                            onClick={() => {
                                clearCoupon();
                                push("info", "Coupon removed");
                            }}
                        >
                            Remove coupon
                        </button>
                    ) : null}
                </div>
                <dl className="totals">
                    <div className="totals-row">
                        <dt>Subtotal</dt>
                        <dd data-testid="subtotal">{formatPrice(totals.subtotalCents)}</dd>
                    </div>
                    {cart.coupon ? (
                        <div className="totals-row">
                            <dt>Discount (10%)</dt>
                            <dd className="totals-discount" data-testid="discount">
                                −{formatPrice(totals.discountCents)}
                            </dd>
                        </div>
                    ) : null}
                    <div className="totals-row totals-row-grand">
                        <dt>Total</dt>
                        <dd data-testid="total">{formatPrice(totals.totalCents)}</dd>
                    </div>
                </dl>
                <Link to="/checkout" className="button button-primary button-block" data-testid="checkout-link">
                    Checkout ({itemCount} item{itemCount === 1 ? "" : "s"})
                </Link>
            </section>
        </main>
    );
}
