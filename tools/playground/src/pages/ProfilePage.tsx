import { useState } from "react";
import { Link } from "react-router-dom";
import type { ProfileData } from "../types";

interface ProfilePageProps {
    username: string;
}

function ProfilePage({ username }: ProfilePageProps) {
    const [profile, setProfile] = useState<ProfileData>({
        username,
        email: `${username.toLowerCase()}@example.com`,
        bio: "",
        theme: "light",
        notifications: true,
    });
    const [isEditing, setIsEditing] = useState(false);
    const [saved, setSaved] = useState(false);

    const handleSave = (e: React.FormEvent) => {
        e.preventDefault();
        setIsEditing(false);
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
    };

    return (
        <div className="page profile-page" data-testid="profile-page">
            <div className="page-header">
                <h1>Profile</h1>
                <p className="page-subtitle">Manage your account information</p>
            </div>

            {saved && (
                <div className="alert alert-success" data-testid="save-success">
                    Profile saved successfully!
                </div>
            )}

            <div className="profile-layout">
                <aside className="profile-sidebar" data-testid="profile-sidebar">
                    <div className="avatar-section">
                        <div className="avatar" data-testid="user-avatar">
                            {username.charAt(0).toUpperCase()}
                        </div>
                        <h3>{username}</h3>
                        <p className="text-muted">{profile.email}</p>
                    </div>

                    <nav className="sidebar-nav" data-testid="sidebar-nav">
                        <Link to="/profile" className="sidebar-link active" data-testid="sidebar-profile">
                            👤 Profile Info
                        </Link>
                        <Link to="/settings" className="sidebar-link" data-testid="sidebar-settings">
                            ⚙️ Settings
                        </Link>
                        <Link to="/dashboard" className="sidebar-link" data-testid="sidebar-dashboard">
                            📊 Dashboard
                        </Link>
                    </nav>
                </aside>

                <main className="profile-content">
                    <div className="card" data-testid="profile-card">
                        <div className="card-header">
                            <h2>Profile Information</h2>
                            {!isEditing && (
                                <button
                                    onClick={() => setIsEditing(true)}
                                    className="btn btn-secondary btn-sm"
                                    data-testid="edit-profile-button"
                                >
                                    Edit
                                </button>
                            )}
                        </div>

                        {isEditing ? (
                            <form onSubmit={handleSave} data-testid="profile-form">
                                <div className="form-group">
                                    <label htmlFor="profile-username">Username</label>
                                    <input
                                        id="profile-username"
                                        type="text"
                                        value={profile.username}
                                        onChange={(e) =>
                                            setProfile({ ...profile, username: e.target.value })
                                        }
                                        data-testid="profile-username-input"
                                    />
                                </div>

                                <div className="form-group">
                                    <label htmlFor="profile-email">Email</label>
                                    <input
                                        id="profile-email"
                                        type="email"
                                        value={profile.email}
                                        onChange={(e) =>
                                            setProfile({ ...profile, email: e.target.value })
                                        }
                                        data-testid="profile-email-input"
                                    />
                                </div>

                                <div className="form-group">
                                    <label htmlFor="profile-bio">Bio</label>
                                    <textarea
                                        id="profile-bio"
                                        value={profile.bio}
                                        onChange={(e) =>
                                            setProfile({ ...profile, bio: e.target.value })
                                        }
                                        placeholder="Tell us about yourself..."
                                        rows={4}
                                        data-testid="profile-bio-input"
                                    />
                                </div>

                                <div className="form-actions">
                                    <button
                                        type="submit"
                                        className="btn btn-primary"
                                        data-testid="save-profile-button"
                                    >
                                        Save Changes
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setIsEditing(false)}
                                        className="btn btn-secondary"
                                        data-testid="cancel-edit-button"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </form>
                        ) : (
                            <div className="profile-details" data-testid="profile-details">
                                <div className="detail-row">
                                    <span className="detail-label">Username</span>
                                    <span className="detail-value" data-testid="display-username">
                                        {profile.username}
                                    </span>
                                </div>
                                <div className="detail-row">
                                    <span className="detail-label">Email</span>
                                    <span className="detail-value" data-testid="display-email">
                                        {profile.email}
                                    </span>
                                </div>
                                <div className="detail-row">
                                    <span className="detail-label">Bio</span>
                                    <span className="detail-value" data-testid="display-bio">
                                        {profile.bio || "No bio set"}
                                    </span>
                                </div>
                            </div>
                        )}
                    </div>
                </main>
            </div>
        </div>
    );
}

export default ProfilePage;
