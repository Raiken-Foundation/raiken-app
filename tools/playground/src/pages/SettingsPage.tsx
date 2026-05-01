import { useEffect, useId, useState } from "react";
import { resetStore } from "../api";
import ConfirmDialog from "../components/ConfirmDialog";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";

const THEME_KEY = "playground.theme";

type Theme = "light" | "dark";

function readTheme(): Theme {
    if (typeof window === "undefined") return "light";
    try {
        return (window.localStorage.getItem(THEME_KEY) as Theme) ?? "light";
    } catch {
        return "light";
    }
}

export default function SettingsPage() {
    const { user, logout } = useAuth();
    const { push } = useToast();
    const [theme, setTheme] = useState<Theme>(readTheme);
    const [notifications, setNotifications] = useState(true);
    const [confirmReset, setConfirmReset] = useState(false);
    const themeId = useId();
    const notifyId = useId();

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        try {
            window.localStorage.setItem(THEME_KEY, theme);
        } catch {
            // ignore
        }
    }, [theme]);

    const handleReset = () => {
        resetStore();
        push("success", "Mock data reset");
        setConfirmReset(false);
    };

    return (
        <div className="page" data-testid="settings-page">
            <header className="page-header">
                <div>
                    <h1>Settings</h1>
                    <p className="page-subtitle">
                        Tune your experience. Preferences are scoped to this browser.
                    </p>
                </div>
            </header>

            <section className="card" data-testid="settings-preferences">
                <h3>Preferences</h3>
                <div className="form-group">
                    <label htmlFor={themeId}>Theme</label>
                    <select
                        id={themeId}
                        value={theme}
                        onChange={(e) => setTheme(e.target.value as Theme)}
                        data-testid="theme-select"
                    >
                        <option value="light">Light</option>
                        <option value="dark">Dark</option>
                    </select>
                </div>
                <div className="form-group form-group-inline">
                    <input
                        id={notifyId}
                        type="checkbox"
                        checked={notifications}
                        onChange={(e) => setNotifications(e.target.checked)}
                        data-testid="notifications-toggle"
                    />
                    <label htmlFor={notifyId}>Email me about activity in my projects</label>
                </div>
            </section>

            <section className="card card-danger" data-testid="settings-danger">
                <h3>Danger zone</h3>
                <p className="muted">
                    Mock data lives in memory only. Resetting wipes any tasks, projects and comments
                    you created during this session.
                </p>
                <div className="settings-danger-actions">
                    <button
                        type="button"
                        className="btn btn-danger"
                        onClick={() => setConfirmReset(true)}
                        data-testid="reset-data"
                    >
                        Reset mock data
                    </button>
                    {user && (
                        <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => {
                                logout();
                                push("info", "Signed out");
                            }}
                            data-testid="settings-logout"
                        >
                            Sign out
                        </button>
                    )}
                </div>
            </section>

            <ConfirmDialog
                open={confirmReset}
                title="Reset mock data?"
                message="This will restore the default seed data. Anything you've created in this session will be lost."
                confirmLabel="Reset"
                danger
                onConfirm={handleReset}
                onCancel={() => setConfirmReset(false)}
            />
        </div>
    );
}
