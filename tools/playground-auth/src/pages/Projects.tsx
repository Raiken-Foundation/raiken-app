import { useState } from "react";
import { Link } from "react-router-dom";
import Nav from "../Nav";

const ALL_PROJECTS = [
    { id: "orion-launch", name: "Orion Launch", status: "active", tasks: 12, owner: "alice" },
    { id: "atlas-migration", name: "Atlas Migration", status: "active", tasks: 8, owner: "bob" },
    { id: "helix-redesign", name: "Helix Redesign", status: "active", tasks: 5, owner: "carol" },
    { id: "mercury-sandbox", name: "Mercury Sandbox", status: "active", tasks: 3, owner: "alice" },
    { id: "legacy-reporting", name: "Legacy Reporting", status: "archived", tasks: 0, owner: "dave" },
    { id: "nova-api", name: "Nova API", status: "archived", tasks: 0, owner: "bob" },
];

export default function Projects() {
    const [status, setStatus] = useState("all");
    const [search, setSearch] = useState("");

    const filtered = ALL_PROJECTS.filter((p) => {
        if (status !== "all" && p.status !== status) return false;
        if (search && !p.name.toLowerCase().includes(search.toLowerCase())) return false;
        return true;
    });

    return (
        <div className="app-shell" data-testid="projects-page">
            <Nav />
            <main className="main-content">
                <div className="page-header">
                    <h1>Projects</h1>
                    <p>All projects across Acme Corp.</p>
                </div>

                <div className="card" style={{ marginBottom: "1rem" }}>
                    <div style={{ display: "flex", gap: ".75rem", alignItems: "center" }}>
                        <input
                            data-testid="projects-search"
                            placeholder="Search projects…"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            style={{ flex: 1, padding: ".4rem .75rem", border: "1px solid var(--border)", borderRadius: "var(--radius)", fontSize: ".875rem" }}
                        />
                        <select
                            data-testid="projects-status-filter"
                            value={status}
                            onChange={(e) => setStatus(e.target.value)}
                            style={{ padding: ".4rem .75rem", border: "1px solid var(--border)", borderRadius: "var(--radius)", fontSize: ".875rem" }}
                        >
                            <option value="all">All statuses</option>
                            <option value="active">Active</option>
                            <option value="archived">Archived</option>
                        </select>
                        <button
                            data-testid="open-create-project"
                            className="btn-primary"
                            style={{ width: "auto", padding: ".4rem 1rem" }}
                            type="button"
                        >
                            New project
                        </button>
                    </div>
                </div>

                <div className="card">
                    <table data-testid="projects-table">
                        <thead>
                            <tr>
                                <th>
                                    <button
                                        data-testid="sort-name"
                                        style={{ background: "none", border: "none", cursor: "pointer", font: "inherit", color: "inherit" }}
                                        type="button"
                                    >
                                        Name ↕
                                    </button>
                                </th>
                                <th>Status</th>
                                <th>Open tasks</th>
                                <th>Owner</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map((p) => (
                                <tr key={p.id} data-testid={`project-row-${p.id}`}>
                                    <td>
                                        <Link
                                            to={`/projects/${p.id}`}
                                            data-testid={`project-link-${p.id}`}
                                        >
                                            {p.name}
                                        </Link>
                                    </td>
                                    <td>
                                        <span className={`badge badge-${p.status}`}>{p.status}</span>
                                    </td>
                                    <td>{p.tasks}</td>
                                    <td>{p.owner}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </main>
        </div>
    );
}
