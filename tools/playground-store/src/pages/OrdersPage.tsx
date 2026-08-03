import { Link } from "react-router-dom";
import { formatPrice } from "../components/ProductCard";
import { EmptyState } from "../components/EmptyState";
import { readOrders } from "../api/store";

export function OrdersPage() {
    const orders = readOrders();

    return (
        <main className="page" data-testid="orders-page">
            <h1>Your orders</h1>
            {orders.length === 0 ? (
                <EmptyState
                    title="No orders yet"
                    hint="Orders you place appear here."
                    action={
                        <Link to="/" className="button button-primary">
                            Browse catalog
                        </Link>
                    }
                />
            ) : (
                <ul className="orders-list" data-testid="orders-list">
                    {orders.map((order) => (
                        <li key={order.id} className="card order-card" data-testid={`order-${order.id}`}>
                            <header>
                                <strong data-testid={`order-id-${order.id}`}>{order.id}</strong>
                                <span className="muted">{order.lines.length} line(s)</span>
                            </header>
                            <p className="muted">
                                {order.lines.map((line) => `${line.name} × ${line.quantity}`).join(", ")}
                            </p>
                            <p data-testid={`order-total-${order.id}`}>
                                {formatPrice(order.totalCents)}
                            </p>
                        </li>
                    ))}
                </ul>
            )}
        </main>
    );
}
