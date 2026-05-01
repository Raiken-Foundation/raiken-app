import { Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";

export default function HomePage() {
    const { isLoggedIn } = useAuth();
    return (
        <div className="page home-page" data-testid="home-page">
            <section className="hero">
                <h1>Atlas Tracker</h1>
                <p className="hero-subtitle">
                    A small project & task tracker — built as a Raiken playground.
                </p>
                <div className="hero-actions">
                    {isLoggedIn ? (
                        <Link
                            to="/dashboard"
                            className="btn btn-primary"
                            data-testid="hero-dashboard"
                        >
                            Open dashboard
                        </Link>
                    ) : (
                        <Link to="/login" className="btn btn-primary" data-testid="hero-login">
                            Sign in to continue
                        </Link>
                    )}
                    <Link to="/about" className="btn btn-secondary" data-testid="hero-about">
                        Learn more
                    </Link>
                </div>
            </section>

            <section className="feature-grid" data-testid="feature-grid">
                <Feature
                    title="Projects"
                    description="Search, sort, paginate and create projects."
                    testId="feature-projects"
                />
                <Feature
                    title="Tasks"
                    description="Filter by status, change progress, delete (admin)."
                    testId="feature-tasks"
                />
                <Feature
                    title="Activity feed"
                    description="Every state change is recorded for the audit trail."
                    testId="feature-activity"
                />
                <Feature
                    title="Permissions"
                    description="Admins can mutate; members read and contribute."
                    testId="feature-perms"
                />
            </section>
        </div>
    );
}

function Feature({
    title,
    description,
    testId,
}: {
    title: string;
    description: string;
    testId: string;
}) {
    return (
        <article className="feature-card" data-testid={testId}>
            <h3>{title}</h3>
            <p>{description}</p>
        </article>
    );
}
