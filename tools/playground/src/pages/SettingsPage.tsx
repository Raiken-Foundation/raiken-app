import { useEffect, useState } from "react";
import * as api from "../api";
import { Skeleton } from "../components/Skeleton";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";

export function SettingsPage() {
    const { user, can } = useAuth();
    const { push } = useToast();
    const [activityCount, setActivityCount] = useState<number | null>(null);
    const [clearing, setClearing] = useState(false);
    const [resetting, setResetting] = useState(false);

    useEffect(() => {
        void api.listActivity().then((entries) => setActivityCount(entries.length));
    }, []);

    const handleClearActivity = async () => {
        try {
            await api.clearActivity(user!);
            push("success", "Activity feed cleared");
            setActivityCount(0);
            setClearing(false);
        } catch (err) {
            push("error", err instanceof Error ? err.message : "Could not clear the feed.");
            setClearing(false);
        }
    };

    const handleReseed = async () => {
        try {
            await api.reseedFixture(user!);
            push("success", "Fixture reset to the seed data");
            setResetting(false);
        } catch (err) {
            push("error", err instanceof Error ? err.message : "Could not reset the fixture.");
            setResetting(false);
        }
    };

    return (
        <main className="page" data-testid="settings-page">
            <header className="page-header">
                <h1>Settings</h1>
            </header>
            <section className="card settings-section">
                <h2>Workspace</h2>
                <p className="muted">Signed in as {user?.displayName} ({user?.role}).</p>
                <dl className="settings-list">
                    <dt>Activity feed</dt>
                    <dd>
                        {activityCount === null ? (
                            <Skeleton lines={1} />
                        ) : (
                            <span data-testid="activity-count">
                                {activityCount} entr{activityCount === 1 ? "y" : "ies"}
                            </span>
                        )}{" "}
                        {can("manage") ? (
                            <button
                                type="button"
                                className="button button-danger-outline button-sm"
                                data-testid="clear-activity"
                                onClick={() => setClearing(true)}
                            >
                                Clear feed
                            </button>
                        ) : null}
                    </dd>
                </dl>
            </section>
            <section className="card settings-section">
                <h2>Fixture controls</h2>
                <p className="muted">
                    This is a demo app — admins can reset the seeded data at any time.
                </p>
                {can("manage") ? (
                    <button
                        type="button"
                        className="button button-ghost"
                        data-testid="reseed-fixture"
                        onClick={() => setResetting(true)}
                    >
                        Reset fixture to seed data
                    </button>
                ) : null}
            </section>

            {clearing ? (
                <ConfirmDialog
                    title="Clear the activity feed?"
                    body="All activity entries are removed. New actions still record."
                    confirmLabel="Clear feed"
                    onConfirm={() => void handleClearActivity()}
                    onCancel={() => setClearing(false)}
                />
            ) : null}

            {resetting ? (
                <ConfirmDialog
                    title="Reset the fixture?"
                    body="Projects, tasks, comments, and activity return to the original seed data."
                    confirmLabel="Reset fixture"
                    onConfirm={() => void handleReseed()}
                    onCancel={() => setResetting(false)}
                />
            ) : null}
        </main>
    );
}
