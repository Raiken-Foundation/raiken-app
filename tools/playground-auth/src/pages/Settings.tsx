import { useState } from "react";
import Nav from "../Nav";

export default function Settings() {
    const [saved, setSaved] = useState(false);

    const handleSave = (e: React.FormEvent) => {
        e.preventDefault();
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
    };

    return (
        <div className="app-shell" data-testid="settings-page">
            <Nav />
            <main className="main-content">
                <div className="page-header">
                    <h1>Settings</h1>
                    <p>Workspace and account preferences.</p>
                </div>

                <div className="card" style={{ maxWidth: 560 }}>
                    <h2 style={{ fontSize: "1rem", marginBottom: "1.25rem" }}>Workspace</h2>
                    <form onSubmit={handleSave} data-testid="settings-form">
                        <div className="form-group">
                            <label htmlFor="workspace-name">Workspace name</label>
                            <input
                                id="workspace-name"
                                type="text"
                                defaultValue="Acme Corp"
                                data-testid="workspace-name-input"
                            />
                        </div>
                        <div className="form-group">
                            <label htmlFor="workspace-slug">URL slug</label>
                            <input
                                id="workspace-slug"
                                type="text"
                                defaultValue="acme-corp"
                                data-testid="workspace-slug-input"
                            />
                        </div>
                        <div className="form-group">
                            <label htmlFor="timezone">Timezone</label>
                            <select
                                id="timezone"
                                data-testid="timezone-select"
                                defaultValue="UTC"
                                style={{ width: "100%", padding: ".5rem .75rem", border: "1px solid var(--border)", borderRadius: "var(--radius)", fontSize: ".9rem" }}
                            >
                                <option value="UTC">UTC</option>
                                <option value="America/New_York">Eastern Time</option>
                                <option value="America/Los_Angeles">Pacific Time</option>
                                <option value="Europe/London">London</option>
                                <option value="Europe/Berlin">Berlin</option>
                            </select>
                        </div>
                        <button
                            type="submit"
                            className="btn-primary"
                            style={{ width: "auto", padding: ".5rem 1.25rem" }}
                            data-testid="settings-save"
                        >
                            {saved ? "Saved ✓" : "Save changes"}
                        </button>
                    </form>
                </div>

                <div className="card" style={{ maxWidth: 560, marginTop: "1rem" }}>
                    <h2 style={{ fontSize: "1rem", marginBottom: "1.25rem" }}>Danger zone</h2>
                    <p style={{ fontSize: ".875rem", color: "var(--muted)", marginBottom: "1rem" }}>
                        Irreversible actions. Proceed with caution.
                    </p>
                    <button
                        data-testid="delete-workspace"
                        type="button"
                        style={{
                            padding: ".5rem 1rem", background: "white", border: "1px solid var(--danger)",
                            color: "var(--danger)", borderRadius: "var(--radius)", cursor: "pointer", fontSize: ".875rem",
                        }}
                    >
                        Delete workspace
                    </button>
                </div>
            </main>
        </div>
    );
}
