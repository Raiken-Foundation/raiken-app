import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from "react";

export type ToastTone = "info" | "success" | "error";

export interface Toast {
    id: string;
    tone: ToastTone;
    message: string;
}

interface ToastContextValue {
    toasts: Toast[];
    push: (tone: ToastTone, message: string) => void;
    dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TIMEOUT_MS = 4500;

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const dismiss = useCallback((id: string) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    const push = useCallback((tone: ToastTone, message: string) => {
        const id = `tst_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        setToasts((prev) => [...prev, { id, tone, message }]);
    }, []);

    // Auto-dismiss after TIMEOUT_MS. Each new toast schedules its own timer.
    useEffect(() => {
        if (toasts.length === 0) return;
        const timers = toasts.map((toast) =>
            window.setTimeout(() => dismiss(toast.id), TIMEOUT_MS),
        );
        return () => {
            for (const t of timers) window.clearTimeout(t);
        };
    }, [toasts, dismiss]);

    const value = useMemo<ToastContextValue>(
        () => ({ toasts, push, dismiss }),
        [toasts, push, dismiss],
    );

    return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast(): ToastContextValue {
    const ctx = useContext(ToastContext);
    if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
    return ctx;
}
