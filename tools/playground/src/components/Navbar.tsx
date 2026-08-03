import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { Avatar } from "./Avatar";

const NAV_ITEMS = [
    { label: "Dashboard", to: "/dashboard", testId: "nav-dashboard" },
    { label: "Projects", to: "/projects", testId: "nav-projects" },
    { label: "Team", to: "/team", testId: "nav-team" },
    { label: "Settings", to: "/settings", testId: "nav-settings" },
];

export function Navbar() {
    const { user, logout } = useAuth();
    const navigate = useNavigate();

    return (
        <header className="topbar" data-testid="navbar">
            <NavLink to="/dashboard" className="brand" data-testid="brand">
                Orbit
            </NavLink>
            <nav className="nav-links" aria-label="Main">
                {NAV_ITEMS.map((item) => (
                    <NavLink
                        key={item.to}
                        to={item.to}
                        className={({ isActive }) => `nav-link ${isActive ? "nav-link-active" : ""}`}
                        data-testid={item.testId}
                    >
                        {item.label}
                    </NavLink>
                ))}
            </nav>
            <div className="topbar-right">
                <NavLink
                    to="/profile"
                    className="user-chip"
                    data-testid="user-chip"
                    aria-label={`Account for ${user?.displayName ?? "unknown"}`}
                >
                    <Avatar name={user?.displayName ?? "?"} size="sm" />
                    <span className="user-chip-name">{user?.displayName ?? "Sign in"}</span>
                </NavLink>
                <button
                    type="button"
                    className="button button-ghost button-sm"
                    data-testid="logout-button"
                    onClick={() => {
                        logout();
                        navigate("/login");
                    }}
                >
                    Sign out
                </button>
            </div>
        </header>
    );
}
