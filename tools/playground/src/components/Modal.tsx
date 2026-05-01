import { type ReactNode, useEffect, useRef } from "react";

interface ModalProps {
    open: boolean;
    title: string;
    onClose: () => void;
    children: ReactNode;
    /** Wider content for forms with many fields. */
    wide?: boolean;
    /** Optional footer (action buttons). */
    footer?: ReactNode;
    /** Stable test id; defaults to "modal". */
    testId?: string;
}

export default function Modal({
    open,
    title,
    onClose,
    children,
    wide = false,
    footer,
    testId = "modal",
}: ModalProps) {
    const cardRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        // Focus the first focusable element when the modal opens. We
        // intentionally use requestAnimationFrame so the elements are
        // mounted before we look for them.
        const raf = requestAnimationFrame(() => {
            const target = cardRef.current?.querySelector<HTMLElement>(
                "input, textarea, select, button:not([data-modal-close])",
            );
            target?.focus();
        });
        return () => {
            window.removeEventListener("keydown", onKey);
            cancelAnimationFrame(raf);
        };
    }, [open, onClose]);

    if (!open) return null;

    return (
        <div className="modal-root">
            {/* The backdrop is a dismissal click target, but the actual
                accessible affordance is the close button inside the dialog. */}
            <button
                type="button"
                className="modal-backdrop"
                aria-label="Close dialog"
                onClick={onClose}
                tabIndex={-1}
                data-testid={`${testId}-backdrop`}
            />
            <div
                ref={cardRef}
                className={`modal-card ${wide ? "modal-card-wide" : ""}`}
                role="dialog"
                aria-modal="true"
                aria-labelledby={`${testId}-title`}
                data-testid={testId}
            >
                <header className="modal-header">
                    <h3 id={`${testId}-title`}>{title}</h3>
                    <button
                        type="button"
                        className="modal-close"
                        onClick={onClose}
                        aria-label="Close dialog"
                        data-modal-close
                        data-testid={`${testId}-close`}
                    >
                        ×
                    </button>
                </header>
                <div className="modal-body">{children}</div>
                {footer && <footer className="modal-footer">{footer}</footer>}
            </div>
        </div>
    );
}
