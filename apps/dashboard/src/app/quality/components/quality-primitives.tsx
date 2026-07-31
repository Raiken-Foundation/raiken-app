import { useId } from "react";
import { formatErrorMessage } from "../helpers";
import type { StatusStripItem } from "../types";

export function PanelHeader({ name, brief }: { name: string; brief: string }) {
    return (
        <header className="q-head">
            <h2 className="q-head-title">
                <span className="q-head-hash" aria-hidden="true">
                    #
                </span>
                {name}
            </h2>
            <p className="q-head-brief">{brief}</p>
        </header>
    );
}

export function CommandLine({
    parts,
    onRun,
    running,
    disabled,
    runLabel = "run",
    shortcut,
}: {
    parts: string[];
    onRun: () => void;
    running?: boolean;
    disabled?: boolean;
    runLabel?: string;
    shortcut?: string;
}) {
    return (
        <div className="q-cmd">
            <div className="q-cmd-line">
                <span className="q-cmd-prompt" aria-hidden="true">
                    $
                </span>
                <code className="q-cmd-text">
                    <span className="q-cmd-bin">raiken</span>
                    {parts.map((p) => (
                        <span key={p} className={p.startsWith("--") ? "q-cmd-flag" : "q-cmd-arg"}>
                            {" "}
                            {p}
                        </span>
                    ))}
                </code>
            </div>
            <button
                type="button"
                className="q-run"
                onClick={onRun}
                disabled={disabled || running}
                aria-label={running ? "running" : `${runLabel}${shortcut ? ` (${shortcut})` : ""}`}
                title={running ? "running" : `${runLabel}${shortcut ? ` (${shortcut})` : ""}`}
            >
                {running ? (
                    <>
                        <span className="q-run-spin" aria-hidden="true" />
                        <span className="q-run-label">running</span>
                    </>
                ) : (
                    <>
                        <span className="q-run-glyph" aria-hidden="true">
                            ▶
                        </span>
                        <span className="q-run-label">{runLabel}</span>
                        {shortcut && <kbd className="q-run-kbd">{shortcut}</kbd>}
                    </>
                )}
            </button>
        </div>
    );
}

export function ArgRow({
    flag,
    htmlFor,
    children,
    hint,
}: {
    flag: string;
    htmlFor?: string;
    children: React.ReactNode;
    hint?: string;
}) {
    return (
        <div className="q-arg">
            <label className="q-arg-flag" htmlFor={htmlFor}>
                {flag}
            </label>
            <div className="q-arg-input">{children}</div>
            {hint && <span className="q-arg-hint">{hint}</span>}
        </div>
    );
}

export function ArgsBlock({ children }: { children: React.ReactNode }) {
    return <div className="q-args">{children}</div>;
}

export function ToggleRow({
    flag,
    checked,
    onChange,
    description,
}: {
    flag: string;
    checked: boolean;
    onChange: (v: boolean) => void;
    description: string;
}) {
    const id = useId();
    return (
        <div className="q-arg q-arg--toggle">
            <label className="q-arg-flag" htmlFor={id}>
                {flag}
            </label>
            <div className="q-arg-input">
                <label className="q-toggle">
                    <input
                        id={id}
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => onChange(e.target.checked)}
                    />
                    <span className="q-toggle-mark" aria-hidden="true" />
                    <span className="q-toggle-text">{description}</span>
                </label>
            </div>
        </div>
    );
}

export function ErrorLine({ error }: { error: unknown }) {
    if (!error) return null;
    return (
        <output className="q-err" role="alert">
            <span className="q-err-tag">ERR</span>
            <span className="q-err-msg">{formatErrorMessage(error)}</span>
        </output>
    );
}

export function StatusStrip({
    items,
    extra,
}: {
    items: StatusStripItem[];
    extra?: React.ReactNode;
}) {
    return (
        <div className="q-strip">
            {items.map((it) => (
                <span key={it.label} className={`q-strip-item q-strip-item--${it.tone || "muted"}`}>
                    <span className="q-strip-val">{it.value}</span>
                    <span className="q-strip-label">{it.label}</span>
                </span>
            ))}
            {extra && <span className="q-strip-extra">{extra}</span>}
        </div>
    );
}

export function OutputPanel({
    title,
    rightMeta,
    children,
    empty,
}: {
    title: string;
    rightMeta?: React.ReactNode;
    children?: React.ReactNode;
    empty?: React.ReactNode;
}) {
    return (
        <section className="q-out">
            <header className="q-out-head">
                <span className="q-out-title">{title}</span>
                {rightMeta && <span className="q-out-meta">{rightMeta}</span>}
            </header>
            <div className="q-out-body">
                {children || <div className="q-out-empty">{empty}</div>}
            </div>
        </section>
    );
}

export function StdoutLine({ n, children }: { n: number; children: React.ReactNode }) {
    return (
        <div className="q-line">
            <span className="q-line-n" aria-hidden="true">
                {String(n).padStart(3, "0")}
            </span>
            <div className="q-line-body">{children}</div>
        </div>
    );
}

export function SevTag({ level }: { level: "error" | "warning" | "info" }) {
    const text = level === "error" ? "CRIT" : level === "warning" ? "WARN" : "NOTE";
    return <span className={`q-sev q-sev--${level}`}>{text}</span>;
}

export function Spinner({ label }: { label: string }) {
    return (
        <div className="q-spin-row">
            <span className="q-spin" aria-hidden="true" />
            <span>{label}</span>
        </div>
    );
}
