import { NavLink, useNavigate } from "react-router-dom";

const NAV_LINKS = [
    { to: "/dashboard", label: "Dashboard", testid: "nav-dashboard" },
    { to: "/projects", label: "Projects", testid: "nav-projects" },
    { to: "/tasks", label: "Tasks", testid: "nav-tasks" },
    { to: "/members", label: "Members", testid: "nav-members" },
    { to: "/settings", label: "Settings", testid: "nav-settings" },
];

function getUser(): string {
    const match = document.cookie.match(/raiken-session=([^;]+)/);
    if (!match) return "guest";
    try {
        const payload = JSON.parse(atob(match[1]));
        return payload.user ?? "guest";
    } catch {
        return "guest";
    }
}

export default function Nav() {
    const navigate = useNavigate();

    const handleLogout = async () => {
        await fetch("/auth/signout", { method: "GET" });
        navigate("/auth/login");
    };

    return (
        <aside className="sidebar" data-testid="sidebar">
            <div className="sidebar-logo">
                Acme <span>Corp</span>
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
                    {getUser()}
                </div>
                <button
                    className="logout-btn"
                    data-testid="logout-button"
                    onClick={handleLogout}
                    type="button"
                >
                    Sign out
                </button>
            </div>
        </aside>
    );
}
