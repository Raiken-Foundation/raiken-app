import { useState, type FormEvent } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { FormField } from "../components/FormField";
import { Avatar } from "../components/Avatar";

export function ProfilePage() {
    const { user } = useAuth();
    const { push } = useToast();
    const [displayName, setDisplayName] = useState(user?.displayName ?? "");

    // The fixture keeps the profile local (no backend persistence) — the
    // submit acknowledges the edit so the form has a real interaction.
    const handleSubmit = (event: FormEvent) => {
        event.preventDefault();
        if (!displayName.trim()) {
            push("error", "Display name cannot be empty.");
            return;
        }
        push("success", "Profile updated (demo — not persisted)");
    };

    return (
        <main className="page" data-testid="profile-page">
            <header className="page-header">
                <h1>Profile</h1>
            </header>
            <section className="card profile-card">
                <div className="profile-identity">
                    <Avatar name={user?.displayName ?? "?"} size="lg" />
                    <div>
                        <h2 data-testid="profile-display-name">{displayName}</h2>
                        <p className="muted" data-testid="profile-username">
                            @{user?.username} · {user?.role}
                        </p>
                        <p className="muted">{user?.email}</p>
                    </div>
                </div>
                <form onSubmit={handleSubmit} className="profile-form">
                    <FormField label="Display name" htmlFor="display-name-input">
                        <input
                            id="display-name-input"
                            className="input"
                            type="text"
                            value={displayName}
                            data-testid="display-name-input"
                            onChange={(event) => setDisplayName(event.target.value)}
                        />
                    </FormField>
                    <button
                        type="submit"
                        className="button button-primary"
                        data-testid="profile-save"
                    >
                        Save
                    </button>
                </form>
            </section>
        </main>
    );
}
