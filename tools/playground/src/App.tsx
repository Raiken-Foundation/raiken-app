import { useState } from "react";
import { Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import Navbar from "./components/Navbar";
import LoginForm from "./components/LoginForm";
import HomePage from "./pages/HomePage";
import DashboardPage from "./pages/DashboardPage";
import ProfilePage from "./pages/ProfilePage";
import SettingsPage from "./pages/SettingsPage";
import AboutPage from "./pages/AboutPage";
import ContactPage from "./pages/ContactPage";
import NotFoundPage from "./pages/NotFoundPage";

function ProtectedRoute({
    isLoggedIn,
    children,
}: {
    isLoggedIn: boolean;
    children: React.ReactNode;
}) {
    if (!isLoggedIn) {
        return <Navigate to="/login" replace />;
    }
    return <>{children}</>;
}

function App() {
    const [isLoggedIn, setIsLoggedIn] = useState(false);
    const [username, setUsername] = useState("");
    const navigate = useNavigate();
    const location = useLocation();

    const handleLogin = (user: string) => {
        setIsLoggedIn(true);
        setUsername(user);
        navigate("/dashboard");
    };

    const handleLogout = () => {
        setIsLoggedIn(false);
        setUsername("");
        navigate("/");
    };

    // Hide navbar on login page
    const showNavbar = location.pathname !== "/login";

    return (
        <div className="app-layout">
            {showNavbar && (
                <Navbar
                    isLoggedIn={isLoggedIn}
                    username={username}
                    onLogout={handleLogout}
                />
            )}

            <main className="app-content">
                <Routes>
                    {/* Public routes */}
                    <Route
                        path="/"
                        element={<HomePage isLoggedIn={isLoggedIn} />}
                    />
                    <Route path="/about" element={<AboutPage />} />
                    <Route path="/contact" element={<ContactPage />} />
                    <Route
                        path="/login"
                        element={
                            isLoggedIn ? (
                                <Navigate to="/dashboard" replace />
                            ) : (
                                <LoginForm onLogin={handleLogin} />
                            )
                        }
                    />

                    {/* Protected routes */}
                    <Route
                        path="/dashboard"
                        element={
                            <ProtectedRoute isLoggedIn={isLoggedIn}>
                                <DashboardPage username={username} />
                            </ProtectedRoute>
                        }
                    />
                    <Route
                        path="/profile"
                        element={
                            <ProtectedRoute isLoggedIn={isLoggedIn}>
                                <ProfilePage username={username} />
                            </ProtectedRoute>
                        }
                    />
                    <Route
                        path="/settings"
                        element={
                            <ProtectedRoute isLoggedIn={isLoggedIn}>
                                <SettingsPage />
                            </ProtectedRoute>
                        }
                    />

                    {/* 404 */}
                    <Route path="*" element={<NotFoundPage />} />
                </Routes>
            </main>

            <footer className="app-footer" data-testid="app-footer">
                <p>&copy; 2026 Raiken Playground. Built for E2E testing.</p>
            </footer>
        </div>
    );
}

export default App;
