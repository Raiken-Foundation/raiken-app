import { useEffect, useState } from "react";
import { FormField } from "../components/FormField";
import { useToast } from "../contexts/ToastContext";

export function LoginPage() {
    const { pushToast } = useToast();
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        document.title = "Sign in — Scrawl";
    }, []);

    function handleSubmit(event: React.FormEvent) {
        event.preventDefault();
        if (!username.trim() || !password.trim()) {
            setError("Both username and password are required.");
            return;
        }
        // Fixture login: every well-formed set of credentials succeeds.
        setError(null);
        pushToast("success", `Signed in as ${username}.`);
        setUsername("");
        setPassword("");
    }

    return (
        <section data-testid="login-page">
            <h1>Sign in</h1>
            <p className="muted">Any username and password will do — this is a fixture.</p>
            <form className="login-form" data-testid="login-form" onSubmit={handleSubmit}>
                <FormField label="Username" htmlFor="login-username">
                    <input
                        id="login-username"
                        type="text"
                        data-testid="login-username"
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                    />
                </FormField>
                <FormField label="Password" htmlFor="login-password">
                    <input
                        id="login-password"
                        type="password"
                        data-testid="login-password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                    />
                </FormField>
                {error && (
                    <p className="form-error" data-testid="login-error">
                        {error}
                    </p>
                )}
                <div className="form-actions">
                    <button type="submit" className="button primary" data-testid="login-submit">
                        Sign in
                    </button>
                </div>
            </form>
        </section>
    );
}
