import { Link, NavLink } from "react-router-dom";

export function Navbar() {
    return (
        <header className="navbar" data-testid="navbar">
            <Link to="/" className="navbar-brand" data-testid="navbar-brand">
                Scrawl
            </Link>
            <nav className="navbar-links">
                <NavLink to="/" data-testid="nav-notes">
                    Notes
                </NavLink>
                <NavLink to="/new" data-testid="nav-new-note">
                    New note
                </NavLink>
                <NavLink to="/about" data-testid="nav-about">
                    About
                </NavLink>
                <NavLink to="/login" data-testid="nav-login">
                    Sign in
                </NavLink>
            </nav>
        </header>
    );
}
