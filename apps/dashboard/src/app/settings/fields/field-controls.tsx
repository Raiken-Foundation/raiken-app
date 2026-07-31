import { cloneElement, isValidElement, type ReactElement, useId } from "react";

export function FieldGroup({
    label,
    hint,
    children,
    align = "center",
}: {
    label: string;
    hint?: string;
    children: React.ReactNode;
    align?: "center" | "start";
}) {
    const generatedControlId = useId();
    const child = isValidElement(children) ? (children as ReactElement<{ id?: string }>) : null;
    const controlId = child?.props.id ?? generatedControlId;
    const control = child ? cloneElement(child, { id: controlId }) : children;

    return (
        <div className={`field-group ${align === "start" ? "align-start" : ""}`}>
            <div className="field-label-block">
                <label className="field-label" htmlFor={controlId}>
                    {label}
                </label>
                {hint && <p className="field-hint">{hint}</p>}
            </div>
            <div className="field-control">{control}</div>
        </div>
    );
}

export function ToggleSwitch({
    id,
    checked,
    onChange,
}: {
    id?: string;
    checked: boolean;
    onChange: (value: boolean) => void;
}) {
    return (
        <button
            id={id}
            type="button"
            className={`toggle-switch ${checked ? "on" : ""}`}
            onClick={() => onChange(!checked)}
            role="switch"
            aria-checked={checked}
        >
            <span className="toggle-knob" />
        </button>
    );
}

export function SecretField({
    label,
    hint,
    value,
    onChange,
    placeholder,
}: {
    label: string;
    hint?: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
}) {
    return (
        <FieldGroup label={label} hint={hint}>
            <input
                type="password"
                autoComplete="off"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
            />
        </FieldGroup>
    );
}
