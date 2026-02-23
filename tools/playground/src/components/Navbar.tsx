import { NavLink } from "react-router-dom";
import type { NavItem } from "../types";

interface NavbarProps {
    isLoggedIn: boolean;
    username: string;
    onLogout: () => void;
}

const publicLinks: NavItem[] = [
    { path: "/", label: "Home", icon: "🏠", requiresAuth: false },
    { path: "/about", label: "About", icon: "ℹ️", requiresAuth: false },
    { path: "/contact", label: "Contact", icon: "✉️", requiresAuth: false },
];

const protectedLinks: NavItem[] = [
    { path: "/dashboard", label: "Dashboard", icon: "📊", requiresAuth: true },
    { path: "/profile", label: "Profile", icon: "👤", requiresAuth: true },
    { path: "/settings", label: "Settings", icon: "⚙️", requiresAuth: true },
];

function Navbar({ isLoggedIn, username, onLogout }: NavbarProps) {
    const links = isLoggedIn
        ? [...publicLinks, ...protectedLinks]
        : publicLinks;

    return (
        <nav className="navbar" data-testid="navbar">
            <div className="navbar-brand">
                <NavLink to="/" className="brand-link" data-testid="brand-link">
                    Raiken Playground
                </NavLink>
            </div>

            <ul className="navbar-links" data-testid="navbar-links">
                {links.map((link) => (
                    <li key={link.path}>
                        <NavLink
                            to={link.path}
                            className={({ isActive }) =>
                                `nav-link ${isActive ? "active" : ""}`
                            }
                            data-testid={`nav-${link.label.toLowerCase()}`}
                        >
                            <span className="nav-icon">{link.icon}</span>
                            {link.label}
                        </NavLink>
                    </li>
                ))}
            </ul>

            <div className="navbar-actions" data-testid="navbar-actions">
                {isLoggedIn ? (
                    <>
                        <span className="user-badge" data-testid="user-badge">
                            {username}
                        </span>
                        <button
                            onClick={onLogout}
                            className="btn btn-secondary btn-sm"
                            data-testid="logout-button"
                        >
                            Logout
                        </button>
                    </>
                ) : (
                    <NavLink
                        to="/login"
                        className="btn btn-primary btn-sm"
                        data-testid="login-nav-button"
                    >
                        Login
                    </NavLink>
                )}
            </div>
        </nav>
    );
}

export default Navbar;
