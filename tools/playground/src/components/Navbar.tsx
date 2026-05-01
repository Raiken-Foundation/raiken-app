import { NavLink } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import Avatar from "./Avatar";

interface NavbarProps {
    onLogout: () => void;
}

const NAV = [
    { to: "/dashboard", label: "Dashboard" },
    { to: "/projects", label: "Projects" },
    { to: "/activity", label: "Activity" },
    { to: "/settings", label: "Settings" },
];

export default function Navbar({ onLogout }: NavbarProps) {
    const { user } = useAuth();

    return (
        <header className="topbar" data-testid="navbar">
            <div className="topbar-left">
                <NavLink to="/dashboard" className="brand" data-testid="brand">
                    <span className="brand-mark" aria-hidden="true">
                        ◢◣
                    </span>
                    <span className="brand-name">Atlas Tracker</span>
                </NavLink>

                <nav className="topbar-nav" aria-label="Primary">
                    {NAV.map((item) => (
                        <NavLink
                            key={item.to}
                            to={item.to}
                            className={({ isActive }) =>
                                `nav-link ${isActive ? "nav-link-active" : ""}`
                            }
                            data-testid={`nav-${item.label.toLowerCase()}`}
                        >
                            {item.label}
                        </NavLink>
                    ))}
                </nav>
            </div>

            <div className="topbar-right">
                {user && (
                    <>
                        <NavLink to="/profile" className="user-chip" data-testid="user-chip">
                            <Avatar user={user} size="sm" />
                            <span className="user-meta">
                                <span className="user-name">{user.username}</span>
                                <span className="user-role">{user.role}</span>
                            </span>
                        </NavLink>
                        <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={onLogout}
                            data-testid="logout-button"
                        >
                            Sign out
                        </button>
                    </>
                )}
            </div>
        </header>
    );
}
