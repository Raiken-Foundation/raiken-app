import { createContext, type ReactNode, useCallback, useContext, useState } from "react";

type ToastKind = "success" | "error";

interface Toast {
    id: number;
    kind: ToastKind;
    message: string;
}

interface ToastContextValue {
    pushToast: (kind: ToastKind, message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const dismiss = useCallback((id: number) => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
    }, []);

    const pushToast = useCallback(
        (kind: ToastKind, message: string) => {
            const id = nextId++;
            setToasts((current) => [...current, { id, kind, message }]);
            window.setTimeout(() => dismiss(id), 3000);
        },
        [dismiss],
    );

    return (
        <ToastContext.Provider value={{ pushToast }}>
            {children}
            <div className="toast-stack" data-testid="toast-stack">
                {toasts.map((toast) => (
                    <div
                        key={toast.id}
                        className={`toast toast-${toast.kind}`}
                        data-testid={`toast-${toast.kind}`}
                    >
                        {toast.message}
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
}

export function useToast(): ToastContextValue {
    const context = useContext(ToastContext);
    if (!context) throw new Error("useToast must be used within ToastProvider");
    return context;
}
