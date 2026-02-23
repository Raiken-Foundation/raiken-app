import { Link } from "react-router-dom";
import Counter from "../components/Counter";
import TodoList from "../components/TodoList";

interface DashboardPageProps {
    username: string;
}

function DashboardPage({ username }: DashboardPageProps) {
    return (
        <div className="page dashboard-page" data-testid="dashboard-page">
            <div className="page-header">
                <h1>Dashboard</h1>
                <p className="page-subtitle">
                    Welcome back, <strong>{username}</strong>
                </p>
            </div>

            <div className="stats-row" data-testid="stats-row">
                <div className="stat-card" data-testid="stat-tasks">
                    <span className="stat-value">12</span>
                    <span className="stat-label">Active Tasks</span>
                </div>
                <div className="stat-card" data-testid="stat-completed">
                    <span className="stat-value">48</span>
                    <span className="stat-label">Completed</span>
                </div>
                <div className="stat-card" data-testid="stat-streak">
                    <span className="stat-value">7</span>
                    <span className="stat-label">Day Streak</span>
                </div>
                <div className="stat-card" data-testid="stat-score">
                    <span className="stat-value">92%</span>
                    <span className="stat-label">Productivity</span>
                </div>
            </div>

            <div className="dashboard-grid">
                <section className="card" data-testid="counter-section">
                    <div className="card-header">
                        <h2>Counter Demo</h2>
                    </div>
                    <Counter />
                </section>

                <section className="card" data-testid="todo-section">
                    <div className="card-header">
                        <h2>Todo List</h2>
                    </div>
                    <TodoList />
                </section>
            </div>

            <div className="quick-links" data-testid="quick-links">
                <h3>Quick Links</h3>
                <div className="quick-links-grid">
                    <Link
                        to="/profile"
                        className="quick-link"
                        data-testid="quick-link-profile"
                    >
                        <span className="quick-link-icon">👤</span>
                        <span>Edit Profile</span>
                    </Link>
                    <Link
                        to="/settings"
                        className="quick-link"
                        data-testid="quick-link-settings"
                    >
                        <span className="quick-link-icon">⚙️</span>
                        <span>Settings</span>
                    </Link>
                    <Link
                        to="/about"
                        className="quick-link"
                        data-testid="quick-link-about"
                    >
                        <span className="quick-link-icon">ℹ️</span>
                        <span>About</span>
                    </Link>
                    <Link
                        to="/contact"
                        className="quick-link"
                        data-testid="quick-link-contact"
                    >
                        <span className="quick-link-icon">✉️</span>
                        <span>Contact Us</span>
                    </Link>
                </div>
            </div>
        </div>
    );
}

export default DashboardPage;
