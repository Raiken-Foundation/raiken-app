import { useState } from 'react';
import { validateUsername, validateEmail } from '../utils';

interface LoginFormProps {
  onLogin: (username: string) => void;
}

function LoginForm({ onLogin }: LoginFormProps) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<{ username?: string; email?: string }>(
    {}
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const newErrors: { username?: string; email?: string } = {};

    if (!validateUsername(username)) {
      newErrors.username = 'Username must be 3-20 characters';
    }

    if (email && !validateEmail(email)) {
      newErrors.email = 'Invalid email format';
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setErrors({});
    onLogin(username);
  };

  return (
    <form onSubmit={handleSubmit} className="login-form" data-testid="login-form">
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
          <span className="error" data-testid="username-error">
            {errors.username}
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

      <button type="submit" className="btn btn-primary" data-testid="login-submit">
        Login
      </button>
    </form>
  );
}

export default LoginForm;

