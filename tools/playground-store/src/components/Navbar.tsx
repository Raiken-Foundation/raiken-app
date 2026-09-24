import { Link, NavLink } from "react-router-dom";
import { useCart } from "../contexts/CartContext";

export function Navbar() {
    const { itemCount } = useCart();
    return (
        <header className="topbar" data-testid="navbar">
            <Link to="/" className="brand" data-testid="brand">
                Bazaar
            </Link>
            <nav className="nav-links" aria-label="Main">
                <NavLink to="/" className="nav-link" end data-testid="nav-catalog">
                    Catalog
                </NavLink>
                <NavLink to="/cart" className="nav-link" data-testid="nav-cart">
                    Cart
                </NavLink>
                <NavLink to="/orders" className="nav-link" data-testid="nav-orders">
                    Orders
                </NavLink>
            </nav>
            <div className="topbar-right">
                <Link
                    to="/cart"
                    className="cart-badge"
                    data-testid="cart-badge"
                    aria-label={`Cart, ${itemCount} items`}
                >
                    🛒 <span data-testid="cart-count">{itemCount}</span>
                </Link>
            </div>
        </header>
    );
}
