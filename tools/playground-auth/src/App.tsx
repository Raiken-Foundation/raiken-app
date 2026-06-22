import { Navigate, Route, Routes } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import Members from "./pages/Members";
import ProjectDetail from "./pages/ProjectDetail";
import Projects from "./pages/Projects";
import Settings from "./pages/Settings";
import Tasks from "./pages/Tasks";

export default function App() {
    return (
        <Routes>
            {/* Public */}
            <Route path="/auth/login" element={<Login />} />

            {/* Protected — the middleware already guards these at the HTTP level,
                so by the time React renders, a session cookie is present. */}
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/:id" element={<ProjectDetail />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/members" element={<Members />} />
        </Routes>
    );
}
