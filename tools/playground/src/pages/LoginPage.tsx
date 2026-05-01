import { type FormEvent, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ApiError } from "../api";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";

interface LocationState {
    from?: { pathname: string };
}

export default function LoginPage() {
    const { login } = useAuth();
    const { push } = useToast();
    const navigate = useNavigate();
    const location = useLocation();

    const [username, setUsername] = useState("admin");
    const [password, setPassword] = useState("password");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setError(null);
        setSubmitting(true);
        try {
            const user = await login(username, password);
            push("success", `Welcome back, ${user.username}`);
            const state = location.state as LocationState | null;
            const target = state?.from?.pathname ?? "/dashboard";
            navigate(target, { replace: true });
        } catch (err) {
            const message =
                err instanceof ApiError ? err.message : "Something went wrong while signing in.";
            setError(message);
            push("error", message);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="login-page" data-testid="login-page">
            <div className="login-card">
                <header className="login-header">
                    <span className="brand-mark" aria-hidden="true">
                        ◢◣
                    </span>
                    <h2>Atlas Tracker</h2>
                </header>
                <p className="login-subtitle">
                    Sign in to manage projects, tasks and team activity.
                </p>

                <form onSubmit={submit} className="login-form" data-testid="login-form" noValidate>
                    <div className="form-group">
                        <label htmlFor="login-username">Username</label>
                        <input
                            id="login-username"
                            type="text"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            placeholder="admin"
                            autoComplete="username"
                            data-testid="username-input"
                            required
                            minLength={3}
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="login-password">Password</label>
                        <input
                            id="login-password"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="At least 4 characters"
                            autoComplete="current-password"
                            data-testid="password-input"
                            required
                            minLength={4}
                        />
                    </div>

                    {error && (
                        <div className="form-error" role="alert" data-testid="login-error">
                            {error}
                        </div>
                    )}

                    <button
                        type="submit"
                        className="btn btn-primary btn-full"
                        disabled={submitting}
                        data-testid="login-submit"
                    >
                        {submitting ? "Signing in…" : "Sign in"}
                    </button>
                </form>

                <ul className="login-hints" data-testid="login-hints">
                    <li>
                        <code>admin</code> · admin role (can create + delete projects)
                    </li>
                    <li>
                        <code>amelia</code>, <code>jordan</code>, <code>priya</code> · member role
                    </li>
                    <li>Any other username auto-provisions a member account.</li>
                </ul>
            </div>
        </div>
    );
}
