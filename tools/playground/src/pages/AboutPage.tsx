export default function AboutPage() {
    return (
        <div className="page" data-testid="about-page">
            <header className="page-header">
                <div>
                    <h1>About Atlas Tracker</h1>
                    <p className="page-subtitle">
                        A deliberately small project tracker that exercises real UI patterns.
                    </p>
                </div>
            </header>

            <section className="card">
                <h3>What it covers</h3>
                <ul className="bulleted">
                    <li>Asynchronous data fetching with realistic latency.</li>
                    <li>Authentication, roles and protected routes.</li>
                    <li>Tables with sort, filter, search and pagination.</li>
                    <li>Modal forms with client- and server-side validation.</li>
                    <li>Tabbed views, toasts and confirmation dialogs.</li>
                    <li>An activity feed that reflects every mutation.</li>
                </ul>
            </section>

            <section className="card">
                <h3>How Raiken uses it</h3>
                <p>
                    The mock API throws errors with stack frames that point back to{" "}
                    <code>src/api/client.ts</code>, so <code>raiken trace</code> has realistic
                    input. The component graph is wide enough that <code>raiken cover</code> finds
                    meaningful symbols, and the E2E suite under <code>e2e/</code> exercises every
                    panel.
                </p>
            </section>
        </div>
    );
}
