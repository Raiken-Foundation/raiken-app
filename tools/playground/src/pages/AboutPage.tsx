import { Link } from "react-router-dom";

/** Public about page — the discovery eval requires a titled, linked /about. */
export function AboutPage() {
    return (
        <main className="page" data-testid="about-page">
            <h1>About Orbit</h1>
            <p className="lead">
                Orbit is a dogfood fixture: a deliberately realistic project-management app used to
                exercise Raiken's discovery, drafting, and repair flows.
            </p>
            <h2>Demo accounts</h2>
            <p className="muted">Every account uses the password <code>password</code>.</p>
            <table className="table" data-testid="about-accounts">
                <thead>
                    <tr>
                        <th>Username</th>
                        <th>Role</th>
                        <th>What the role can do</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td><code>admin</code></td>
                        <td>Admin</td>
                        <td>Create/archive projects, manage team, clear activity</td>
                    </tr>
                    <tr>
                        <td><code>priya</code></td>
                        <td>Member</td>
                        <td>Create tasks, move statuses, comment</td>
                    </tr>
                    <tr>
                        <td><code>kai</code></td>
                        <td>Viewer</td>
                        <td>Read everything, change nothing</td>
                    </tr>
                </tbody>
            </table>
            <p>
                <Link to="/login" className="link" data-testid="about-login-link">
                    Sign in
                </Link>
            </p>
        </main>
    );
}
