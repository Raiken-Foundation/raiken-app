import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { FormField } from "../components/FormField";

export function LoginPage() {
    const { login } = useAuth();
    const { push } = useToast();
    const navigate = useNavigate();
    const location = useLocation();
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const from = (location.state as { from?: string } | null)?.from ?? "/dashboard";

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault();
        setError(null);
        if (!username.trim() || !password) {
            setError("Enter a username and password.");
            return;
        }
        setBusy(true);
        try {
            const user = await login(username, password);
            push("success", `Welcome back, ${user.displayName}`);
            navigate(from, { replace: true });
        } catch (err) {
            setError(err instanceof Error ? err.message : "Sign in failed.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <main className="page login-page" data-testid="login-page">
            <div className="card login-card">
                <h1>Sign in to Orbit</h1>
                <p className="muted">
                    Demo accounts: <code>admin</code>, <code>priya</code>, or <code>kai</code> —
                    password <code>password</code>.
                </p>
                <form onSubmit={handleSubmit} noValidate>
                    <FormField label="Username" htmlFor="username-input">
                        <input
                            id="username-input"
                            className="input"
                            type="text"
                            autoComplete="username"
                            value={username}
                            data-testid="username-input"
                            onChange={(event) => setUsername(event.target.value)}
                        />
                    </FormField>
                    <FormField label="Password" htmlFor="password-input">
                        <input
                            id="password-input"
                            className="input"
                            type="password"
                            autoComplete="current-password"
                            value={password}
                            data-testid="password-input"
                            onChange={(event) => setPassword(event.target.value)}
                        />
                    </FormField>
                    {error ? (
                        <p className="form-error" role="alert" data-testid="login-error">
                            {error}
                        </p>
                    ) : null}
                    <button
                        type="submit"
                        className="button button-primary button-block"
                        disabled={busy}
                        data-testid="login-submit"
                    >
                        {busy ? "Signing in…" : "Sign in"}
                    </button>
                </form>
            </div>
        </main>
    );
}
