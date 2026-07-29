import { useEffect, useState } from "react";
import { useBlocker } from "react-router-dom";
import { useSession } from "../auth/useSession";
import ConfirmDialog from "../components/ConfirmDialog";
import ReauthDialog from "../components/ReauthDialog";
import UnsavedChangesDialog from "../components/UnsavedChangesDialog";
import Nav from "../Nav";

export default function Settings() {
    const { session, loading, hasPermission } = useSession();
    const [workspaceName, setWorkspaceName] = useState("Acme Corp");
    const [workspaceSlug, setWorkspaceSlug] = useState("acme-corp");
    const [timezone, setTimezone] = useState("UTC");
    const [saved, setSaved] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [showReauth, setShowReauth] = useState(false);
    const [deleteSuccess, setDeleteSuccess] = useState(false);
    const [deleteError, setDeleteError] = useState("");

    const canManageWorkspace = hasPermission("manage:workspace");
    const isAdmin = session?.role === "admin";

    const blocker = useBlocker(
        ({ currentLocation, nextLocation }) =>
            dirty && currentLocation.pathname !== nextLocation.pathname,
    );

    useEffect(() => {
        if (blocker.state === "blocked") {
            document.body.classList.add("modal-open");
        } else {
            document.body.classList.remove("modal-open");
        }
    }, [blocker.state]);

    const markDirty = () => setDirty(true);

    const handleSave = (e: React.FormEvent) => {
        e.preventDefault();
        setSaved(true);
        setDirty(false);
        setTimeout(() => setSaved(false), 2000);
    };

    const handleDeleteConfirmed = () => {
        setShowDeleteConfirm(false);
        setShowReauth(true);
    };

    const handleReauthSuccess = async () => {
        setShowReauth(false);
        setDeleteError("");

        try {
            const response = await fetch("/api/workspace/delete", {
                method: "POST",
                headers: { Accept: "application/json" },
                credentials: "same-origin",
            });
            const data = (await response.json()) as { message?: string; error?: string };

            if (!response.ok) {
                setDeleteError(data.message ?? "Workspace deletion failed.");
                return;
            }

            setDeleteSuccess(true);
        } catch {
            setDeleteError("Workspace deletion failed.");
        }
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
                                value={workspaceName}
                                onChange={(e) => {
                                    setWorkspaceName(e.target.value);
                                    markDirty();
                                }}
                                data-testid="workspace-name-input"
                            />
                        </div>
                        <div className="form-group">
                            <label htmlFor="workspace-slug">URL slug</label>
                            <input
                                id="workspace-slug"
                                type="text"
                                value={workspaceSlug}
                                onChange={(e) => {
                                    setWorkspaceSlug(e.target.value);
                                    markDirty();
                                }}
                                data-testid="workspace-slug-input"
                            />
                        </div>
                        <div className="form-group">
                            <label htmlFor="timezone">Timezone</label>
                            <select
                                id="timezone"
                                data-testid="timezone-select"
                                value={timezone}
                                onChange={(e) => {
                                    setTimezone(e.target.value);
                                    markDirty();
                                }}
                                style={{
                                    width: "100%",
                                    padding: ".5rem .75rem",
                                    border: "1px solid var(--border)",
                                    borderRadius: "var(--radius)",
                                    fontSize: ".9rem",
                                }}
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

                <div className="card danger-zone" style={{ maxWidth: 560, marginTop: "1rem" }}>
                    <h2 style={{ fontSize: "1rem", marginBottom: "1.25rem" }}>Danger zone</h2>

                    {!loading && !isAdmin && (
                        <output
                            className="permission-denied-inline"
                            data-testid="settings-danger-denied"
                        >
                            Workspace deletion is restricted to admins. Your role (
                            <strong>{session?.role ?? "unknown"}</strong>) cannot access destructive
                            actions.
                        </output>
                    )}

                    {!loading && isAdmin && !canManageWorkspace && (
                        <output
                            className="permission-denied-inline"
                            data-testid="settings-danger-denied"
                        >
                            Missing manage:workspace permission.
                        </output>
                    )}

                    {!loading && isAdmin && canManageWorkspace && (
                        <>
                            <p
                                style={{
                                    fontSize: ".875rem",
                                    color: "var(--muted)",
                                    marginBottom: "1rem",
                                }}
                            >
                                Irreversible actions. Proceed with caution.
                            </p>
                            {deleteSuccess ? (
                                <output
                                    className="success-message"
                                    data-testid="workspace-delete-success"
                                >
                                    Workspace deletion simulated successfully.
                                </output>
                            ) : (
                                <>
                                    {deleteError && (
                                        <p
                                            role="alert"
                                            data-testid="workspace-delete-error"
                                            className="form-error"
                                        >
                                            {deleteError}
                                        </p>
                                    )}
                                    <button
                                        data-testid="delete-workspace"
                                        type="button"
                                        className="btn-danger-outline"
                                        onClick={() => setShowDeleteConfirm(true)}
                                    >
                                        Delete workspace
                                    </button>
                                </>
                            )}
                        </>
                    )}
                </div>
            </main>

            {blocker.state === "blocked" && (
                <UnsavedChangesDialog
                    onStay={() => blocker.reset?.()}
                    onDiscard={() => blocker.proceed?.()}
                />
            )}

            {showDeleteConfirm && (
                <ConfirmDialog
                    testId="delete-workspace-dialog"
                    title="Delete workspace?"
                    description="This will permanently remove the workspace and all projects. This action cannot be undone."
                    confirmLabel="Delete workspace"
                    cancelLabel="Cancel"
                    destructive
                    onConfirm={handleDeleteConfirmed}
                    onCancel={() => setShowDeleteConfirm(false)}
                />
            )}

            {showReauth && (
                <ReauthDialog
                    onCancel={() => setShowReauth(false)}
                    onSuccess={() => void handleReauthSuccess()}
                />
            )}
        </div>
    );
}
