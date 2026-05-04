import Nav from "../Nav";

const MEMBERS = [
    { id: "alice", name: "Alice Chen", email: "alice@acme.com", role: "admin", joined: "Jan 2024" },
    { id: "bob", name: "Bob Kim", email: "bob@acme.com", role: "member", joined: "Mar 2024" },
    { id: "carol", name: "Carol Singh", email: "carol@acme.com", role: "member", joined: "Mar 2024" },
    { id: "dave", name: "Dave Okonkwo", email: "dave@acme.com", role: "member", joined: "Jun 2024" },
    { id: "eve", name: "Eve Müller", email: "eve@acme.com", role: "viewer", joined: "Sep 2024" },
    { id: "frank", name: "Frank Rossi", email: "frank@acme.com", role: "viewer", joined: "Dec 2024" },
];

export default function Members() {
    return (
        <div className="app-shell" data-testid="members-page">
            <Nav />
            <main className="main-content">
                <div className="page-header">
                    <h1>Members</h1>
                    <p>People with access to this workspace.</p>
                </div>

                <div className="card">
                    <table data-testid="members-table">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Email</th>
                                <th>Role</th>
                                <th>Joined</th>
                            </tr>
                        </thead>
                        <tbody>
                            {MEMBERS.map((m) => (
                                <tr key={m.id} data-testid={`member-row-${m.id}`}>
                                    <td>{m.name}</td>
                                    <td>
                                        <a href={`mailto:${m.email}`}>{m.email}</a>
                                    </td>
                                    <td>
                                        <span className={`badge badge-${m.role === "admin" ? "active" : m.role === "member" ? "in-progress" : "archived"}`}>
                                            {m.role}
                                        </span>
                                    </td>
                                    <td>{m.joined}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </main>
        </div>
    );
}
