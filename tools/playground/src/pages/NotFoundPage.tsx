import { Link } from "react-router-dom";

function NotFoundPage() {
    return (
        <div className="page not-found-page" data-testid="not-found-page">
            <div className="not-found-content">
                <span className="not-found-code">404</span>
                <h1>Page Not Found</h1>
                <p>The page you're looking for doesn't exist or has been moved.</p>
                <div className="form-actions">
                    <Link to="/" className="btn btn-primary" data-testid="go-home">
                        Go Home
                    </Link>
                    <Link to="/contact" className="btn btn-secondary" data-testid="report-issue">
                        Report Issue
                    </Link>
                </div>
            </div>
        </div>
    );
}

export default NotFoundPage;
