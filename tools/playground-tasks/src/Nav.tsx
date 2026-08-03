import { NavLink } from "react-router-dom";
import { useSession } from "./auth/useSession";

const NAV_LINKS = [
    { to: "/dashboard", label: "Dashboard", testid: "nav-dashboard" },
    { to: "/projects", label: "Projects", testid: "nav-projects" },
    { to: "/tasks", label: "Tasks", testid: "nav-tasks" },
    { to: "/members", label: "Members", testid: "nav-members" },
    { to: "/settings", label: "Settings", testid: "nav-settings" },
];

export default function Nav() {
    const { session, loading } = useSession();
    const displayName = loading ? "Loading…" : (session?.user ?? "guest");
    const displayRole = loading ? "" : (session?.role ?? "");

    return (
        <aside className="sidebar" data-testid="sidebar">
            <div className="sidebar-logo">
                Task<span>Flow</span>
            </div>
            <nav className="sidebar-nav" data-testid="main-nav">
                {NAV_LINKS.map((link) => (
                    <NavLink
                        key={link.to}
                        to={link.to}
                        data-testid={link.testid}
                        className={({ isActive }) => (isActive ? "active" : undefined)}
                    >
                        {link.label}
                    </NavLink>
                ))}
            </nav>
            <div className="sidebar-footer">
                <div className="user-chip" data-testid="user-chip">
                    <span data-testid="user-chip-name">{displayName}</span>
                    {!loading && displayRole && (
                        <span className="user-role" data-testid="user-chip-role">
                            {displayRole}
                        </span>
                    )}
                </div>
                <button
                    className="logout-btn"
                    data-testid="logout-button"
                    onClick={() => window.location.assign("/auth/signout")}
                    type="button"
                >
                    Sign out
                </button>
            </div>
        </aside>
    );
}
