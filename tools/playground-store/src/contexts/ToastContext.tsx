import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useMemo,
    useRef,
    useState,
} from "react";

export type ToastTone = "success" | "error" | "info";

export interface Toast {
    id: string;
    tone: ToastTone;
    message: string;
}

interface ToastContextValue {
    toasts: Toast[];
    push: (tone: ToastTone, message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let toastSeq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

    const push = useCallback((tone: ToastTone, message: string) => {
        const id = `toast-${++toastSeq}`;
        setToasts((current) => [...current.slice(-3), { id, tone, message }]);
        const timer = setTimeout(() => {
            setToasts((current) => current.filter((t) => t.id !== id));
            timers.current.delete(timer);
        }, 4200);
        timers.current.add(timer);
    }, []);

    const value = useMemo(() => ({ toasts, push }), [toasts, push]);

    return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast(): ToastContextValue {
    const ctx = useContext(ToastContext);
    if (!ctx) throw new Error("useToast must be used inside ToastProvider");
    return ctx;
}
