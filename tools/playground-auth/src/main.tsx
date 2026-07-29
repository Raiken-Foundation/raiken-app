import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, Outlet, RouterProvider } from "react-router-dom";
import ProtectedLayout from "./auth/ProtectedLayout";
import CookieConsent from "./components/CookieConsent";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import Members from "./pages/Members";
import Mfa from "./pages/Mfa";
import ProjectDetail from "./pages/ProjectDetail";
import Projects from "./pages/Projects";
import Settings from "./pages/Settings";
import Tasks from "./pages/Tasks";
import "./styles.css";

function RootLayout() {
    return (
        <>
            <CookieConsent />
            <Outlet />
        </>
    );
}

const router = createBrowserRouter([
    {
        element: <RootLayout />,
        children: [
            { path: "/auth/login", element: <Login /> },
            { path: "/auth/mfa", element: <Mfa /> },
            {
                element: <ProtectedLayout />,
                children: [
                    { path: "/", element: <Navigate to="/dashboard" replace /> },
                    { path: "/dashboard", element: <Dashboard /> },
                    { path: "/projects", element: <Projects /> },
                    { path: "/projects/:id", element: <ProjectDetail /> },
                    { path: "/tasks", element: <Tasks /> },
                    { path: "/settings", element: <Settings /> },
                    { path: "/members", element: <Members /> },
                ],
            },
        ],
    },
]);

const rootElement = document.getElementById("root");
if (!rootElement) {
    throw new Error("Missing #root element");
}

createRoot(rootElement).render(
    <StrictMode>
        <RouterProvider router={router} />
    </StrictMode>,
);
