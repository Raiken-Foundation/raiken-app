import { useEffect } from "react";
import { Link } from "react-router-dom";

export function NotFoundPage() {
    useEffect(() => {
        document.title = "Page not found — Scrawl";
    }, []);

    return (
        <section data-testid="not-found-page">
            <h1>Page not found</h1>
            <p>The page you're looking for doesn't exist.</p>
            <Link to="/" className="button" data-testid="back-to-notes">
                Back to notes
            </Link>
        </section>
    );
}
