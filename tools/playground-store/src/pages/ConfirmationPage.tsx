import { Link, useParams } from "react-router-dom";
import { readOrders } from "../api/store";
import { formatPrice } from "../components/ProductCard";

export function ConfirmationPage() {
    const { orderId = "" } = useParams();
    const order = readOrders().find((o) => o.id === orderId);

    if (!order) {
        return (
            <main className="page" data-testid="confirmation-page">
                <h1>Order not found</h1>
                <p className="muted">No order with id {orderId} is on record.</p>
                <Link to="/" className="link">
                    Back to the catalog
                </Link>
            </main>
        );
    }

    return (
        <main className="page" data-testid="confirmation-page">
            <section className="card confirmation-card">
                <h1 data-testid="confirmation-title">Order {order.id} confirmed</h1>
                <p className="muted">Thanks {order.shipping.name} — we are packing your order.</p>
                <ul className="order-review-list" data-testid="confirmation-lines">
                    {order.lines.map((line) => (
                        <li key={line.productId}>
                            <span>
                                {line.name} × {line.quantity}
                            </span>
                            <span>{formatPrice(line.priceCents * line.quantity)}</span>
                        </li>
                    ))}
                </ul>
                <p className="confirmation-total" data-testid="confirmation-total">
                    Total: {formatPrice(order.totalCents)}
                </p>
                <Link to="/orders" className="button button-primary" data-testid="view-orders">
                    View my orders
                </Link>
            </section>
        </main>
    );
}
