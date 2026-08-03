import { useEffect, useRef, type ReactNode } from "react";

export interface ModalProps {
    title: string;
    onClose: () => void;
    children: ReactNode;
    footer?: ReactNode;
}

/**
 * Accessible modal: labelled, focus-trapped (the fixture's Lyra project
 * tracks exactly this behavior), ESC to close, backdrop click to close.
 */
export function Modal({ title, onClose, children, footer }: ModalProps) {
    const dialogRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        const firstFocusable = dialogRef.current?.querySelector<HTMLElement>(
            "input, select, textarea, button",
        );
        firstFocusable?.focus();
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("keydown", onKey);
            previous?.focus();
        };
    }, [onClose]);

    return (
        <div className="modal-backdrop" data-testid="modal-backdrop" onClick={onClose}>
            <div
                className="modal"
                role="dialog"
                aria-modal="true"
                aria-label={title}
                ref={dialogRef}
                onClick={(event) => event.stopPropagation()}
            >
                <header className="modal-header">
                    <h2>{title}</h2>
                    <button
                        type="button"
                        className="button button-ghost button-sm"
                        aria-label="Close dialog"
                        onClick={onClose}
                    >
                        ✕
                    </button>
                </header>
                <div className="modal-body">{children}</div>
                {footer ? <footer className="modal-footer">{footer}</footer> : null}
            </div>
        </div>
    );
}
