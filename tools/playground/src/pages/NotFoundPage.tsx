import { Link } from "react-router-dom";

export function NotFoundPage() {
    return (
        <main className="page" data-testid="not-found-page">
            <h1>Page not found</h1>
            <p className="muted">That route does not exist in Orbit.</p>
            <p>
                <Link to="/dashboard" className="link">
                    Back to the dashboard
                </Link>
            </p>
        </main>
    );
}
