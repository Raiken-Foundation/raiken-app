import { Link } from "react-router-dom";

export default function NotFoundPage() {
    return (
        <div className="page not-found-page" data-testid="not-found-page">
            <h1>Lost in space</h1>
            <p className="page-subtitle">
                The page you're looking for doesn't exist (or never did).
            </p>
            <Link to="/" className="btn btn-primary" data-testid="not-found-home">
                Back home
            </Link>
        </div>
    );
}
