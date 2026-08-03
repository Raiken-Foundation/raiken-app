import { useToast } from "../contexts/ToastContext";

export function Toasts() {
    const { toasts } = useToast();
    if (toasts.length === 0) return null;
    return (
        <div className="toast-stack" aria-live="polite" data-testid="toast-stack">
            {toasts.map((toast) => (
                // biome-ignore lint/a11y/useSemanticElements: toast container is a status region
                <div key={toast.id} className={`toast toast-${toast.tone}`} role="status">
                    {toast.message}
                </div>
            ))}
        </div>
    );
}
