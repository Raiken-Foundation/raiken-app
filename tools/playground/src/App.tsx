import { useState } from 'react';
import Counter from './components/Counter';
import TodoList from './components/TodoList';
import LoginForm from './components/LoginForm';

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [username, setUsername] = useState('');

  const handleLogin = (user: string) => {
    setIsLoggedIn(true);
    setUsername(user);
  };

  const handleLogout = () => {
    setIsLoggedIn(false);
    setUsername('');
  };

  if (!isLoggedIn) {
    return (
      <div className="container">
        <h1>Raiken Playground</h1>
        <p className="subtitle">Test application for E2E testing</p>
        <LoginForm onLogin={handleLogin} />
      </div>
    );
  }

  return (
    <div className="container">
      <header className="header">
        <h1>Welcome, {username}!</h1>
        <button onClick={handleLogout} className="btn btn-secondary">
          Logout
        </button>
      </header>

      <div className="grid">
        <section className="card">
          <h2>Counter Demo</h2>
          <Counter />
        </section>

        <section className="card">
          <h2>Todo List</h2>
          <TodoList />
        </section>
      </div>
    </div>
  );
}

export default App;

