import { Route, Routes } from "react-router-dom";
import { Navbar } from "./components/Navbar";
import { ToastProvider } from "./contexts/ToastContext";
import { AboutPage } from "./pages/AboutPage";
import { ArchivePage } from "./pages/ArchivePage";
import { EditNotePage } from "./pages/EditNotePage";
import { LoginPage } from "./pages/LoginPage";
import { NewNotePage } from "./pages/NewNotePage";
import { NoteDetailPage } from "./pages/NoteDetailPage";
import { NotesPage } from "./pages/NotesPage";
import { NotFoundPage } from "./pages/NotFoundPage";

export default function App() {
    return (
        <ToastProvider>
            <Navbar />
            <main className="page">
                <Routes>
                    <Route path="/" element={<NotesPage />} />
                    <Route path="/note/:slug" element={<NoteDetailPage />} />
                    <Route path="/note/:slug/edit" element={<EditNotePage />} />
                    <Route path="/new" element={<NewNotePage />} />
                    <Route path="/about" element={<AboutPage />} />
                    <Route path="/login" element={<LoginPage />} />
                    {/* Deliberately unlinked: exists as a route but nothing points to it. */}
                    <Route path="/archive" element={<ArchivePage />} />
                    <Route path="*" element={<NotFoundPage />} />
                </Routes>
            </main>
        </ToastProvider>
    );
}
