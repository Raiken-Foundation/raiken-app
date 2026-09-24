import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { validatePayment, validateShipping } from "../api/store";
import { FormField } from "../components/FormField";
import { formatPrice } from "../components/ProductCard";
import { Skeleton } from "../components/Skeleton";
import { useCart } from "../contexts/CartContext";
import { useToast } from "../contexts/ToastContext";

/**
 * Three-step checkout wizard: Shipping → Payment → Review. Each step gates the
 * next with its own validation; Review places the order and hands off to the
 * confirmation page.
 */
export function CheckoutPage() {
    const { cart, products, totals, itemCount, placeOrder } = useCart();
    const { push } = useToast();
    const navigate = useNavigate();
    const [step, setStep] = useState(1);

    const [name, setName] = useState("");
    const [address, setAddress] = useState("");
    const [zip, setZip] = useState("");
    const [cardNumber, setCardNumber] = useState("");
    const [expiry, setExpiry] = useState("");

    const [shippingErrors, setShippingErrors] = useState<Record<string, string>>({});
    const [paymentErrors, setPaymentErrors] = useState<Record<string, string>>({});
    const [placing, setPlacing] = useState(false);

    // Redirect empty carts to the cart page — but not mid-order: placing an
    // order clears the cart, and the redirect must not hijack the navigation
    // to the confirmation page.
    if (cart.lines.length === 0 && !placing) {
        return <Navigate to="/cart" replace />;
    }

    const handleShippingNext = () => {
        const error = validateShipping({ name, address, zip });
        if (error) {
            setShippingErrors({ name: error });
            push("error", error);
            return;
        }
        setShippingErrors({});
        setStep(2);
    };

    const handlePaymentNext = () => {
        const error = validatePayment({ cardNumber, expiry });
        if (error) {
            setPaymentErrors({ cardNumber: error });
            push("error", error);
            return;
        }
        setPaymentErrors({});
        setStep(3);
    };

    const handlePlaceOrder = () => {
        setPlacing(true);
        try {
            const order = placeOrder({ name, address, zip });
            push("success", `Order ${order.id} placed`);
            navigate(`/confirmation/${order.id}`);
        } catch (err) {
            setPlacing(false);
            push("error", err instanceof Error ? err.message : "Could not place the order.");
        }
    };

    const lineItems = cart.lines
        .map((line) => ({ line, product: products.find((p) => p.id === line.productId) }))
        .filter((entry) => entry.product !== undefined);
    const catalogLoaded = lineItems.length === cart.lines.length;

    return (
        <main className="page" data-testid="checkout-page">
            <h1>Checkout</h1>
            <ol className="stepper" data-testid="checkout-stepper">
                <li className={step === 1 ? "stepper-active" : "stepper-done"}>
                    <span>1. Shipping</span>
                </li>
                <li className={step === 2 ? "stepper-active" : step > 2 ? "stepper-done" : ""}>
                    <span>2. Payment</span>
                </li>
                <li className={step === 3 ? "stepper-active" : ""}>
                    <span>3. Review</span>
                </li>
            </ol>

            {step === 1 ? (
                <section className="card checkout-panel" data-testid="shipping-step">
                    <h2>Shipping details</h2>
                    <FormField
                        label="Full name"
                        htmlFor="shipping-name"
                        error={shippingErrors.name}
                    >
                        <input
                            id="shipping-name"
                            className="input"
                            type="text"
                            value={name}
                            data-testid="shipping-name"
                            onChange={(event) => setName(event.target.value)}
                        />
                    </FormField>
                    <FormField label="Address" htmlFor="shipping-address">
                        <input
                            id="shipping-address"
                            className="input"
                            type="text"
                            value={address}
                            data-testid="shipping-address"
                            onChange={(event) => setAddress(event.target.value)}
                        />
                    </FormField>
                    <FormField label="ZIP code" htmlFor="shipping-zip">
                        <input
                            id="shipping-zip"
                            className="input"
                            type="text"
                            value={zip}
                            placeholder="e.g. 10001"
                            data-testid="shipping-zip"
                            onChange={(event) => setZip(event.target.value)}
                        />
                    </FormField>
                    <button
                        type="button"
                        className="button button-primary"
                        data-testid="shipping-next"
                        onClick={handleShippingNext}
                    >
                        Continue to payment
                    </button>
                </section>
            ) : null}

            {step === 2 ? (
                <section className="card checkout-panel" data-testid="payment-step">
                    <h2>Payment</h2>
                    <p className="muted">Demo store — any 16-digit card and MM/YY expiry work.</p>
                    <FormField
                        label="Card number"
                        htmlFor="card-number"
                        error={paymentErrors.cardNumber}
                    >
                        <input
                            id="card-number"
                            className="input"
                            type="text"
                            value={cardNumber}
                            placeholder="4111 1111 1111 1111"
                            data-testid="card-number"
                            onChange={(event) => setCardNumber(event.target.value)}
                        />
                    </FormField>
                    <FormField label="Expiry (MM/YY)" htmlFor="card-expiry">
                        <input
                            id="card-expiry"
                            className="input"
                            type="text"
                            value={expiry}
                            placeholder="12/27"
                            data-testid="card-expiry"
                            onChange={(event) => setExpiry(event.target.value)}
                        />
                    </FormField>
                    <div className="checkout-actions">
                        <button
                            type="button"
                            className="button button-ghost"
                            data-testid="payment-back"
                            onClick={() => setStep(1)}
                        >
                            Back
                        </button>
                        <button
                            type="button"
                            className="button button-primary"
                            data-testid="payment-next"
                            onClick={handlePaymentNext}
                        >
                            Continue to review
                        </button>
                    </div>
                </section>
            ) : null}

            {step === 3 ? (
                <section className="card checkout-panel" data-testid="review-step">
                    <h2>Review your order</h2>
                    <p className="muted">
                        Shipping to {name}, {address} ({zip}).
                    </p>
                    {!catalogLoaded ? (
                        <Skeleton lines={3} />
                    ) : (
                        <>
                            <ul className="order-review-list" data-testid="review-lines">
                                {lineItems.map(({ line, product }) =>
                                    product ? (
                                        <li key={line.productId}>
                                            <span>
                                                {product.name} × {line.quantity}
                                            </span>
                                            <span>
                                                {formatPrice(product.priceCents * line.quantity)}
                                            </span>
                                        </li>
                                    ) : null,
                                )}
                            </ul>
                            <dl className="totals">
                                <div className="totals-row">
                                    <dt>Subtotal</dt>
                                    <dd data-testid="review-subtotal">
                                        {formatPrice(totals.subtotalCents)}
                                    </dd>
                                </div>
                                {cart.coupon ? (
                                    <div className="totals-row">
                                        <dt>Discount</dt>
                                        <dd
                                            className="totals-discount"
                                            data-testid="review-discount"
                                        >
                                            −{formatPrice(totals.discountCents)}
                                        </dd>
                                    </div>
                                ) : null}
                                <div className="totals-row totals-row-grand">
                                    <dt>Total</dt>
                                    <dd data-testid="review-total">
                                        {formatPrice(totals.totalCents)}
                                    </dd>
                                </div>
                            </dl>
                            <div className="checkout-actions">
                                <button
                                    type="button"
                                    className="button button-ghost"
                                    data-testid="review-back"
                                    onClick={() => setStep(2)}
                                >
                                    Back
                                </button>
                                <button
                                    type="button"
                                    className="button button-primary"
                                    data-testid="place-order"
                                    onClick={handlePlaceOrder}
                                >
                                    Place order ({itemCount} item{itemCount === 1 ? "" : "s"})
                                </button>
                            </div>
                        </>
                    )}
                </section>
            ) : null}
        </main>
    );
}
