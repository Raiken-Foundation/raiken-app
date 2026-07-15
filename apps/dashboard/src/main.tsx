import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import type { ErrorInfo, ReactNode } from "react";
import { Component, StrictMode, useState } from "react";
import * as ReactDOM from "react-dom/client";
import App from "./app/app";
import { trpc } from "./utils/trpc";
import "./styles.css";

// A stale lazy-loaded chunk (Vite hashes asset filenames, so a redeploy renames
// them) makes the currently-open page fail to import a route it hasn't loaded
// yet. This is the "Failed to fetch dynamically imported module" error. It's not
// a real app fault — a reload fetches the fresh index.html + chunk names.
function isChunkLoadError(error: Error | null): boolean {
    if (!error) return false;
    const msg = `${error.name} ${error.message}`.toLowerCase();
    return (
        error.name === "ChunkLoadError" ||
        msg.includes("failed to fetch dynamically imported module") ||
        msg.includes("error loading dynamically imported module") ||
        msg.includes("importing a module script failed") ||
        msg.includes("loading chunk")
    );
}

class ErrorBoundary extends Component<
    { children: ReactNode },
    { hasError: boolean; error: Error | null }
> {
    constructor(props: { children: ReactNode }) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error) {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error("Dashboard render error:", error, info);

        // Auto-recover from a stale chunk (typically right after a redeploy)
        // by reloading once. A sessionStorage timestamp guards against a
        // reload loop if the reload doesn't actually resolve it.
        if (isChunkLoadError(error)) {
            try {
                const KEY = "raiken:chunkReloadAt";
                const last = Number(sessionStorage.getItem(KEY) || "0");
                const now = Date.now();
                if (now - last > 10000) {
                    sessionStorage.setItem(KEY, String(now));
                    window.location.reload();
                }
            } catch {
                // sessionStorage unavailable — fall through to the manual UI.
            }
        }
    }

    render() {
        if (this.state.hasError) {
            const chunk = isChunkLoadError(this.state.error);
            return (
                <div
                    style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        height: "100vh",
                        background: "#0a0a0a",
                        color: "#e5e7eb",
                        gap: "1rem",
                        fontFamily: "system-ui, sans-serif",
                    }}
                >
                    <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#ef4444"
                        strokeWidth="1.5"
                        style={{ width: 48, height: 48 }}
                    >
                        <path d="M12 9v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <h2 style={{ margin: 0, fontSize: "1.25rem" }}>
                        {chunk ? "A new version is available" : "Something went wrong"}
                    </h2>
                    <p
                        style={{
                            margin: 0,
                            color: "#6b7280",
                            fontSize: "0.875rem",
                            maxWidth: 400,
                            textAlign: "center",
                        }}
                    >
                        {chunk
                            ? "Raiken was updated while this tab was open. Reload to load the latest version."
                            : this.state.error?.message || "An unexpected error occurred."}
                    </p>
                    <button
                        type="button"
                        onClick={() => window.location.reload()}
                        style={{
                            padding: "0.5rem 1.5rem",
                            background: "#3b82f6",
                            color: "#fff",
                            border: "none",
                            borderRadius: 6,
                            cursor: "pointer",
                            fontSize: "0.875rem",
                        }}
                    >
                        Reload Page
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}

function Root() {
    // refetchOnWindowFocus is disabled globally: re-fetching file content when
    // the window regains focus was silently overwriting unsaved editor edits.
    const [queryClient] = useState(
        () =>
            new QueryClient({
                defaultOptions: {
                    queries: { refetchOnWindowFocus: false },
                },
            }),
    );
    const [trpcClient] = useState(() =>
        trpc.createClient({
            links: [
                httpBatchLink({
                    url: "/api/trpc",
                }),
            ],
        }),
    );

    return (
        <trpc.Provider client={trpcClient} queryClient={queryClient}>
            <QueryClientProvider client={queryClient}>
                <App />
            </QueryClientProvider>
        </trpc.Provider>
    );
}

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

root.render(
    <StrictMode>
        <ErrorBoundary>
            <Root />
        </ErrorBoundary>
    </StrictMode>,
);
