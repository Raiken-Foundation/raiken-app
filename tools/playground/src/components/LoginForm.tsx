import { useState } from "react";
import { validateUsername, validateEmail } from "../utils";

interface LoginFormProps {
    onLogin: (username: string) => void;
}

function LoginForm({ onLogin }: LoginFormProps) {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [email, setEmail] = useState("");
    const [errors, setErrors] = useState<{
        username?: string;
        password?: string;
        email?: string;
    }>({});

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        const newErrors: {
            username?: string;
            password?: string;
            email?: string;
        } = {};

        if (!validateUsername(username)) {
            newErrors.username = "Username must be 3-20 characters";
        }

        if (!password || password.length < 4) {
            newErrors.password = "Password must be at least 4 characters";
        }

        if (email && !validateEmail(email)) {
            newErrors.email = "Invalid email format";
        }

        if (Object.keys(newErrors).length > 0) {
            setErrors(newErrors);
            return;
        }

        setErrors({});
        onLogin(username);
    };

    return (
        <div className="login-page" data-testid="login-page">
            <div className="login-card">
                <h2>Sign In</h2>
                <p className="login-subtitle">
                    Enter your credentials to access the dashboard
                </p>

                <form
                    onSubmit={handleSubmit}
                    className="login-form"
                    data-testid="login-form"
                >
                    <div className="form-group">
                        <label htmlFor="username">Username *</label>
                        <input
                            id="username"
                            type="text"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            placeholder="Enter username"
                            data-testid="username-input"
                        />
                        {errors.username && (
                            <span
                                className="error"
                                data-testid="username-error"
                            >
                                {errors.username}
                            </span>
                        )}
                    </div>

                    <div className="form-group">
                        <label htmlFor="password">Password *</label>
                        <input
                            id="password"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="Enter password"
                            data-testid="password-input"
                        />
                        {errors.password && (
                            <span
                                className="error"
                                data-testid="password-error"
                            >
                                {errors.password}
                            </span>
                        )}
                    </div>

                    <div className="form-group">
                        <label htmlFor="email">Email (optional)</label>
                        <input
                            id="email"
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="Enter email"
                            data-testid="email-input"
                        />
                        {errors.email && (
                            <span className="error" data-testid="email-error">
                                {errors.email}
                            </span>
                        )}
                    </div>

                    <button
                        type="submit"
                        className="btn btn-primary btn-full"
                        data-testid="login-submit"
                    >
                        Sign In
                    </button>
                </form>

                <div className="login-footer">
                    <p className="login-hint">
                        Demo: use any username (3+ chars) and password (4+
                        chars)
                    </p>
                </div>
            </div>
        </div>
    );
}

export default LoginForm;
