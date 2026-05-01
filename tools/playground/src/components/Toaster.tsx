import { useToast } from "../contexts/ToastContext";

export default function Toaster() {
    const { toasts, dismiss } = useToast();
    if (toasts.length === 0) return null;
    return (
        <output className="toaster" aria-live="polite" data-testid="toaster">
            {toasts.map((t) => (
                <div key={t.id} className={`toast toast-${t.tone}`} data-testid={`toast-${t.tone}`}>
                    <span className="toast-message">{t.message}</span>
                    <button
                        type="button"
                        className="toast-close"
                        onClick={() => dismiss(t.id)}
                        aria-label="Dismiss notification"
                    >
                        ×
                    </button>
                </div>
            ))}
        </output>
    );
}
