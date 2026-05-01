import { useId, useState } from "react";
import Avatar from "../components/Avatar";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";

export default function ProfilePage() {
    const { user } = useAuth();
    const { push } = useToast();
    const emailId = useId();
    const bioId = useId();
    const [email, setEmail] = useState(user?.email ?? "");
    const [bio, setBio] = useState("");
    const [saving, setSaving] = useState(false);

    if (!user) return null;

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        // Simulate a save round-trip without persisting.
        await new Promise((resolve) => setTimeout(resolve, 250));
        setSaving(false);
        push("success", "Profile saved");
    };

    return (
        <div className="page" data-testid="profile-page">
            <header className="page-header">
                <div>
                    <h1>Profile</h1>
                    <p className="page-subtitle">Manage your personal details.</p>
                </div>
            </header>

            <section className="card profile-card">
                <div className="profile-identity">
                    <Avatar user={user} size="lg" />
                    <div>
                        <h3 data-testid="profile-username">{user.username}</h3>
                        <span className={`pill pill-role-${user.role}`}>{user.role}</span>
                    </div>
                </div>

                <form className="profile-form" onSubmit={submit}>
                    <div className="form-group">
                        <label htmlFor={emailId}>Email</label>
                        <input
                            id={emailId}
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            data-testid="profile-email"
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor={bioId}>Bio</label>
                        <textarea
                            id={bioId}
                            rows={3}
                            value={bio}
                            onChange={(e) => setBio(e.target.value)}
                            placeholder="Tell your team a little about yourself"
                            data-testid="profile-bio"
                        />
                    </div>
                    <button
                        type="submit"
                        className="btn btn-primary"
                        disabled={saving}
                        data-testid="profile-save"
                    >
                        {saving ? "Saving…" : "Save changes"}
                    </button>
                </form>
            </section>
        </div>
    );
}
