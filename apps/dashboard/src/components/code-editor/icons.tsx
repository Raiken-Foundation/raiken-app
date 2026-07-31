export function IconButton({
    label,
    onClick,
    children,
    disabled,
    state,
    tone,
}: {
    label: string;
    onClick: () => void;
    children: React.ReactNode;
    disabled?: boolean;
    state?: "loading" | "success";
    tone?: "run" | "danger-active";
}) {
    const cls = ["ce-icon-btn", tone ? `ce-icon-btn--${tone}` : "", state ? `is-${state}` : ""]
        .filter(Boolean)
        .join(" ");
    return (
        <button
            type="button"
            className={cls}
            onClick={onClick}
            disabled={disabled}
            title={label}
            aria-label={label}
        >
            {children}
        </button>
    );
}

// Decorative icons: parent <button> always carries the accessible label/title.
export function IconClose() {
    return (
        <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
    );
}
export function IconPlus() {
    return (
        <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M8 3v10M3 8h10" />
        </svg>
    );
}
export function IconSave() {
    return (
        <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M3 3h8l2 2v8H3V3z" />
            <path d="M5 3v3h5V3" />
            <path d="M5 9h6v4H5z" />
        </svg>
    );
}
export function IconCheck() {
    return (
        <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M3 8.5l3 3 7-7" />
        </svg>
    );
}
export function IconTrash() {
    return (
        <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M3 4h10M6 4V2.5h4V4M5 4l.5 9h5l.5-9" />
        </svg>
    );
}
export function IconPlay() {
    return (
        <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M5 3.5l7 4.5-7 4.5V3.5z" />
        </svg>
    );
}
export function IconSpinner() {
    return (
        <svg
            className="ce-spin"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M8 2a6 6 0 1 1-6 6" />
        </svg>
    );
}
