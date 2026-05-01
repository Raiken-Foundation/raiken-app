import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import Navbar from "./components/Navbar";
import Toaster from "./components/Toaster";
import { useAuth } from "./contexts/AuthContext";
import { useToast } from "./contexts/ToastContext";
import AboutPage from "./pages/AboutPage";
import ActivityPage from "./pages/ActivityPage";
import ContactPage from "./pages/ContactPage";
import DashboardPage from "./pages/DashboardPage";
import HomePage from "./pages/HomePage";
import LoginPage from "./pages/LoginPage";
import NotFoundPage from "./pages/NotFoundPage";
import ProfilePage from "./pages/ProfilePage";
import ProjectDetailPage from "./pages/ProjectDetailPage";
import ProjectsListPage from "./pages/ProjectsListPage";
import SettingsPage from "./pages/SettingsPage";

function ProtectedRoute({ children }: { children: ReactNode }) {
    const { isLoggedIn } = useAuth();
    const location = useLocation();
    if (!isLoggedIn) {
        return <Navigate to="/login" replace state={{ from: location }} />;
    }
    return <>{children}</>;
}

export default function App() {
    const { isLoggedIn, logout } = useAuth();
    const { push } = useToast();
    const location = useLocation();
    const navigate = useNavigate();

    const showNavbar = isLoggedIn && location.pathname !== "/login";

    const handleLogout = () => {
        logout();
        push("info", "Signed out");
        navigate("/login", { replace: true });
    };

    return (
        <div className="app-layout">
            {showNavbar && <Navbar onLogout={handleLogout} />}

            <main className="app-content">
                <Routes>
                    <Route path="/" element={<HomePage />} />
                    <Route path="/about" element={<AboutPage />} />
                    <Route path="/contact" element={<ContactPage />} />
                    <Route
                        path="/login"
                        element={isLoggedIn ? <Navigate to="/dashboard" replace /> : <LoginPage />}
                    />

                    <Route
                        path="/dashboard"
                        element={
                            <ProtectedRoute>
                                <DashboardPage />
                            </ProtectedRoute>
                        }
                    />
                    <Route
                        path="/projects"
                        element={
                            <ProtectedRoute>
                                <ProjectsListPage />
                            </ProtectedRoute>
                        }
                    />
                    <Route
                        path="/projects/:slug"
                        element={
                            <ProtectedRoute>
                                <ProjectDetailPage />
                            </ProtectedRoute>
                        }
                    />
                    <Route
                        path="/activity"
                        element={
                            <ProtectedRoute>
                                <ActivityPage />
                            </ProtectedRoute>
                        }
                    />
                    <Route
                        path="/profile"
                        element={
                            <ProtectedRoute>
                                <ProfilePage />
                            </ProtectedRoute>
                        }
                    />
                    <Route
                        path="/settings"
                        element={
                            <ProtectedRoute>
                                <SettingsPage />
                            </ProtectedRoute>
                        }
                    />

                    <Route path="*" element={<NotFoundPage />} />
                </Routes>
            </main>

            <Toaster />

            <footer className="app-footer" data-testid="app-footer">
                <p>Atlas Tracker — built as a Raiken playground. Mock data resets on refresh.</p>
            </footer>
        </div>
    );
}
