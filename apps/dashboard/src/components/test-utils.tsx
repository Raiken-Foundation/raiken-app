import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderOptions, render } from "@testing-library/react";
import { httpBatchLink } from "@trpc/client";
import type { ReactElement, ReactNode } from "react";
import { trpc } from "../utils/trpc";

// Create a wrapper with all required providers for testing
function createTestWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: {
                retry: false,
            },
        },
    });

    const trpcClient = trpc.createClient({
        links: [
            httpBatchLink({
                url: "http://localhost:7101/api/trpc",
            }),
        ],
    });

    return function TestWrapper({ children }: { children: ReactNode }) {
        return (
            <trpc.Provider client={trpcClient} queryClient={queryClient}>
                <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
            </trpc.Provider>
        );
    };
}

// Custom render function that wraps components with providers
function customRender(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
    return render(ui, { wrapper: createTestWrapper(), ...options });
}

// Re-export everything from testing-library
export * from "@testing-library/react";

// Override render with our custom render
export { customRender as render };
