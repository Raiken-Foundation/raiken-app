import { Link } from "react-router-dom";

interface HomePageProps {
    isLoggedIn: boolean;
}

function HomePage({ isLoggedIn }: HomePageProps) {
    return (
        <div className="page home-page" data-testid="home-page">
            <section className="hero">
                <h1>Welcome to Raiken Playground</h1>
                <p className="hero-subtitle">
                    A multi-page test application for E2E testing with
                    autonomous site discovery
                </p>

                <div className="hero-actions">
                    {isLoggedIn ? (
                        <Link
                            to="/dashboard"
                            className="btn btn-primary btn-lg"
                            data-testid="go-to-dashboard"
                        >
                            Go to Dashboard
                        </Link>
                    ) : (
                        <Link
                            to="/login"
                            className="btn btn-primary btn-lg"
                            data-testid="go-to-login"
                        >
                            Get Started
                        </Link>
                    )}
                    <Link
                        to="/about"
                        className="btn btn-secondary btn-lg"
                        data-testid="learn-more"
                    >
                        Learn More
                    </Link>
                </div>
            </section>

            <section className="features-grid" data-testid="features-grid">
                <div className="feature-card">
                    <span className="feature-icon">📊</span>
                    <h3>Dashboard</h3>
                    <p>View your activity stats, recent items, and quick actions.</p>
                    <Link to={isLoggedIn ? "/dashboard" : "/login"} className="feature-link" data-testid="feature-dashboard">
                        Explore Dashboard →
                    </Link>
                </div>

                <div className="feature-card">
                    <span className="feature-icon">✅</span>
                    <h3>Todo Manager</h3>
                    <p>Create, filter, and manage your tasks with ease.</p>
                    <Link to={isLoggedIn ? "/dashboard" : "/login"} className="feature-link" data-testid="feature-todos">
                        Manage Todos →
                    </Link>
                </div>

                <div className="feature-card">
                    <span className="feature-icon">👤</span>
                    <h3>Profile</h3>
                    <p>Customize your profile and manage your account.</p>
                    <Link to={isLoggedIn ? "/profile" : "/login"} className="feature-link" data-testid="feature-profile">
                        Edit Profile →
                    </Link>
                </div>

                <div className="feature-card">
                    <span className="feature-icon">⚙️</span>
                    <h3>Settings</h3>
                    <p>Configure themes, notifications, and preferences.</p>
                    <Link to={isLoggedIn ? "/settings" : "/login"} className="feature-link" data-testid="feature-settings">
                        Open Settings →
                    </Link>
                </div>
            </section>
        </div>
    );
}

export default HomePage;
