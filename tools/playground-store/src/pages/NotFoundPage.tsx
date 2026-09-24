import { Link } from "react-router-dom";

export function NotFoundPage() {
    return (
        <main className="page" data-testid="not-found-page">
            <h1>Page not found</h1>
            <p className="muted">That page does not exist in Bazaar.</p>
            <Link to="/" className="link">
                Back to the catalog
            </Link>
        </main>
    );
}
