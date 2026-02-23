import { useState } from "react";
import { Link } from "react-router-dom";

interface Settings {
    theme: "light" | "dark" | "system";
    language: string;
    notifications: {
        email: boolean;
        push: boolean;
        sms: boolean;
    };
    privacy: {
        profilePublic: boolean;
        showEmail: boolean;
        showActivity: boolean;
    };
    accessibility: {
        fontSize: "small" | "medium" | "large";
        highContrast: boolean;
        reduceMotion: boolean;
    };
}

function SettingsPage() {
    const [settings, setSettings] = useState<Settings>({
        theme: "light",
        language: "en",
        notifications: { email: true, push: true, sms: false },
        privacy: { profilePublic: true, showEmail: false, showActivity: true },
        accessibility: {
            fontSize: "medium",
            highContrast: false,
            reduceMotion: false,
        },
    });
    const [activeTab, setActiveTab] = useState<
        "general" | "notifications" | "privacy" | "accessibility"
    >("general");
    const [saved, setSaved] = useState(false);

    const handleSave = () => {
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
    };

    return (
        <div className="page settings-page" data-testid="settings-page">
            <div className="page-header">
                <h1>Settings</h1>
                <p className="page-subtitle">
                    Configure your application preferences
                </p>
            </div>

            {saved && (
                <div
                    className="alert alert-success"
                    data-testid="settings-saved"
                >
                    Settings saved successfully!
                </div>
            )}

            <div className="settings-layout">
                <aside className="settings-tabs" data-testid="settings-tabs">
                    <button
                        onClick={() => setActiveTab("general")}
                        className={`tab-btn ${activeTab === "general" ? "active" : ""}`}
                        data-testid="tab-general"
                    >
                        🎨 General
                    </button>
                    <button
                        onClick={() => setActiveTab("notifications")}
                        className={`tab-btn ${activeTab === "notifications" ? "active" : ""}`}
                        data-testid="tab-notifications"
                    >
                        🔔 Notifications
                    </button>
                    <button
                        onClick={() => setActiveTab("privacy")}
                        className={`tab-btn ${activeTab === "privacy" ? "active" : ""}`}
                        data-testid="tab-privacy"
                    >
                        🔒 Privacy
                    </button>
                    <button
                        onClick={() => setActiveTab("accessibility")}
                        className={`tab-btn ${activeTab === "accessibility" ? "active" : ""}`}
                        data-testid="tab-accessibility"
                    >
                        ♿ Accessibility
                    </button>
                </aside>

                <main className="settings-content">
                    {activeTab === "general" && (
                        <div
                            className="card"
                            data-testid="general-settings"
                        >
                            <h2>General Settings</h2>

                            <div className="form-group">
                                <label htmlFor="theme">Theme</label>
                                <select
                                    id="theme"
                                    value={settings.theme}
                                    onChange={(e) =>
                                        setSettings({
                                            ...settings,
                                            theme: e.target.value as Settings["theme"],
                                        })
                                    }
                                    data-testid="theme-select"
                                >
                                    <option value="light">Light</option>
                                    <option value="dark">Dark</option>
                                    <option value="system">System</option>
                                </select>
                            </div>

                            <div className="form-group">
                                <label htmlFor="language">Language</label>
                                <select
                                    id="language"
                                    value={settings.language}
                                    onChange={(e) =>
                                        setSettings({
                                            ...settings,
                                            language: e.target.value,
                                        })
                                    }
                                    data-testid="language-select"
                                >
                                    <option value="en">English</option>
                                    <option value="es">Spanish</option>
                                    <option value="fr">French</option>
                                    <option value="de">German</option>
                                    <option value="ja">Japanese</option>
                                </select>
                            </div>
                        </div>
                    )}

                    {activeTab === "notifications" && (
                        <div
                            className="card"
                            data-testid="notification-settings"
                        >
                            <h2>Notification Preferences</h2>

                            <div className="toggle-group">
                                <label className="toggle-label">
                                    <input
                                        type="checkbox"
                                        checked={settings.notifications.email}
                                        onChange={(e) =>
                                            setSettings({
                                                ...settings,
                                                notifications: {
                                                    ...settings.notifications,
                                                    email: e.target.checked,
                                                },
                                            })
                                        }
                                        data-testid="toggle-email-notif"
                                    />
                                    <span>Email Notifications</span>
                                </label>

                                <label className="toggle-label">
                                    <input
                                        type="checkbox"
                                        checked={settings.notifications.push}
                                        onChange={(e) =>
                                            setSettings({
                                                ...settings,
                                                notifications: {
                                                    ...settings.notifications,
                                                    push: e.target.checked,
                                                },
                                            })
                                        }
                                        data-testid="toggle-push-notif"
                                    />
                                    <span>Push Notifications</span>
                                </label>

                                <label className="toggle-label">
                                    <input
                                        type="checkbox"
                                        checked={settings.notifications.sms}
                                        onChange={(e) =>
                                            setSettings({
                                                ...settings,
                                                notifications: {
                                                    ...settings.notifications,
                                                    sms: e.target.checked,
                                                },
                                            })
                                        }
                                        data-testid="toggle-sms-notif"
                                    />
                                    <span>SMS Notifications</span>
                                </label>
                            </div>
                        </div>
                    )}

                    {activeTab === "privacy" && (
                        <div
                            className="card"
                            data-testid="privacy-settings"
                        >
                            <h2>Privacy Settings</h2>

                            <div className="toggle-group">
                                <label className="toggle-label">
                                    <input
                                        type="checkbox"
                                        checked={settings.privacy.profilePublic}
                                        onChange={(e) =>
                                            setSettings({
                                                ...settings,
                                                privacy: {
                                                    ...settings.privacy,
                                                    profilePublic:
                                                        e.target.checked,
                                                },
                                            })
                                        }
                                        data-testid="toggle-public-profile"
                                    />
                                    <span>Public Profile</span>
                                </label>

                                <label className="toggle-label">
                                    <input
                                        type="checkbox"
                                        checked={settings.privacy.showEmail}
                                        onChange={(e) =>
                                            setSettings({
                                                ...settings,
                                                privacy: {
                                                    ...settings.privacy,
                                                    showEmail: e.target.checked,
                                                },
                                            })
                                        }
                                        data-testid="toggle-show-email"
                                    />
                                    <span>Show Email Address</span>
                                </label>

                                <label className="toggle-label">
                                    <input
                                        type="checkbox"
                                        checked={settings.privacy.showActivity}
                                        onChange={(e) =>
                                            setSettings({
                                                ...settings,
                                                privacy: {
                                                    ...settings.privacy,
                                                    showActivity:
                                                        e.target.checked,
                                                },
                                            })
                                        }
                                        data-testid="toggle-show-activity"
                                    />
                                    <span>Show Activity Status</span>
                                </label>
                            </div>
                        </div>
                    )}

                    {activeTab === "accessibility" && (
                        <div
                            className="card"
                            data-testid="accessibility-settings"
                        >
                            <h2>Accessibility</h2>

                            <div className="form-group">
                                <label htmlFor="font-size">Font Size</label>
                                <select
                                    id="font-size"
                                    value={settings.accessibility.fontSize}
                                    onChange={(e) =>
                                        setSettings({
                                            ...settings,
                                            accessibility: {
                                                ...settings.accessibility,
                                                fontSize: e.target
                                                    .value as Settings["accessibility"]["fontSize"],
                                            },
                                        })
                                    }
                                    data-testid="font-size-select"
                                >
                                    <option value="small">Small</option>
                                    <option value="medium">Medium</option>
                                    <option value="large">Large</option>
                                </select>
                            </div>

                            <div className="toggle-group">
                                <label className="toggle-label">
                                    <input
                                        type="checkbox"
                                        checked={
                                            settings.accessibility.highContrast
                                        }
                                        onChange={(e) =>
                                            setSettings({
                                                ...settings,
                                                accessibility: {
                                                    ...settings.accessibility,
                                                    highContrast:
                                                        e.target.checked,
                                                },
                                            })
                                        }
                                        data-testid="toggle-high-contrast"
                                    />
                                    <span>High Contrast Mode</span>
                                </label>

                                <label className="toggle-label">
                                    <input
                                        type="checkbox"
                                        checked={
                                            settings.accessibility.reduceMotion
                                        }
                                        onChange={(e) =>
                                            setSettings({
                                                ...settings,
                                                accessibility: {
                                                    ...settings.accessibility,
                                                    reduceMotion:
                                                        e.target.checked,
                                                },
                                            })
                                        }
                                        data-testid="toggle-reduce-motion"
                                    />
                                    <span>Reduce Motion</span>
                                </label>
                            </div>
                        </div>
                    )}

                    <div className="settings-actions">
                        <button
                            onClick={handleSave}
                            className="btn btn-primary"
                            data-testid="save-settings-button"
                        >
                            Save Settings
                        </button>
                        <Link
                            to="/dashboard"
                            className="btn btn-secondary"
                            data-testid="back-to-dashboard"
                        >
                            Back to Dashboard
                        </Link>
                    </div>
                </main>
            </div>
        </div>
    );
}

export default SettingsPage;
