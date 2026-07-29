import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

export default function Mfa() {
    const [error, setError] = useState("");
    const [code, setCode] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setError("");

        if (!/^\d{6}$/.test(code)) {
            setError("Enter the 6-digit verification code.");
            return;
        }

        const body = new URLSearchParams({ code });
        const res = await fetch("/auth/callback/mfa", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
            },
            body: body.toString(),
            redirect: "manual",
            credentials: "same-origin",
        });

        if (res.status === 401) {
            const data = (await res.json()) as { message?: string };
            setError(data.message ?? "Invalid verification code.");
            return;
        }

        if (res.ok) {
            const data = (await res.json()) as { redirect?: string };
            window.location.assign(data.redirect ?? "/dashboard");
            return;
        }

        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get("Location") ?? "/dashboard";
            window.location.assign(location);
            return;
        }

        setError("Verification failed. Please try again.");
    };

    return (
        <div className="login-wrapper" data-testid="mfa-page">
            <div className="login-card">
                <h1>Two-factor authentication</h1>
                <p className="subtitle">Enter the 6-digit code from your authenticator app.</p>

                <form data-testid="mfa-form" onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label htmlFor="mfa-code">Verification code</label>
                        <input
                            ref={inputRef}
                            id="mfa-code"
                            name="code"
                            type="text"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            pattern="\d{6}"
                            maxLength={6}
                            data-testid="mfa-code-input"
                            placeholder="000000"
                            value={code}
                            onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                            required
                        />
                    </div>

                    {error && (
                        <p role="alert" data-testid="mfa-error" className="form-error">
                            {error}
                        </p>
                    )}

                    <button type="submit" className="btn-primary" data-testid="mfa-submit">
                        Verify
                    </button>
                </form>

                <p className="login-hint">
                    Fixture MFA code: <code data-testid="mfa-hint-code">123456</code>
                </p>
                <p className="login-hint">
                    <Link to="/auth/login" data-testid="mfa-back-to-login">
                        Back to sign in
                    </Link>
                </p>
            </div>
        </div>
    );
}
