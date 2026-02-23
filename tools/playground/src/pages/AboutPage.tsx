import { Link } from "react-router-dom";

function AboutPage() {
    return (
        <div className="page about-page" data-testid="about-page">
            <div className="page-header">
                <h1>About</h1>
                <p className="page-subtitle">
                    Learn more about the Raiken Playground
                </p>
            </div>

            <div className="content-grid">
                <section className="card" data-testid="about-mission">
                    <h2>Our Mission</h2>
                    <p>
                        The Raiken Playground is a multi-page test application
                        designed to exercise autonomous site discovery, auth
                        detection, and E2E test generation. It provides a
                        realistic surface area for crawlers to navigate.
                    </p>
                </section>

                <section className="card" data-testid="about-features">
                    <h2>Features</h2>
                    <ul className="feature-list">
                        <li data-testid="feature-item-auth">
                            <strong>Authentication</strong> — Login with
                            username/password, session management
                        </li>
                        <li data-testid="feature-item-dashboard">
                            <strong>Dashboard</strong> — Stats, counters, and
                            todo management
                        </li>
                        <li data-testid="feature-item-profile">
                            <strong>Profile</strong> — Edit user information
                            with form validation
                        </li>
                        <li data-testid="feature-item-settings">
                            <strong>Settings</strong> — Tabbed interface with
                            toggles and selects
                        </li>
                        <li data-testid="feature-item-contact">
                            <strong>Contact</strong> — Multi-field form with
                            validation
                        </li>
                    </ul>
                </section>

                <section className="card" data-testid="about-tech">
                    <h2>Technology Stack</h2>
                    <div className="tech-badges">
                        <span className="badge" data-testid="badge-react">React 18</span>
                        <span className="badge" data-testid="badge-router">React Router</span>
                        <span className="badge" data-testid="badge-ts">TypeScript</span>
                        <span className="badge" data-testid="badge-vite">Vite</span>
                        <span className="badge" data-testid="badge-pw">Playwright</span>
                    </div>
                </section>

                <section className="card" data-testid="about-team">
                    <h2>Team</h2>
                    <div className="team-grid">
                        <div className="team-member" data-testid="team-member-1">
                            <div className="member-avatar">R</div>
                            <h4>Raiken Bot</h4>
                            <p>QA Agent</p>
                        </div>
                        <div className="team-member" data-testid="team-member-2">
                            <div className="member-avatar">D</div>
                            <h4>Developer</h4>
                            <p>Human in the loop</p>
                        </div>
                    </div>
                </section>
            </div>

            <div className="page-footer-links">
                <Link to="/contact" className="btn btn-primary" data-testid="about-contact-link">
                    Get in Touch
                </Link>
                <Link to="/" className="btn btn-secondary" data-testid="about-home-link">
                    Back to Home
                </Link>
            </div>
        </div>
    );
}

export default AboutPage;
