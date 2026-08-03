import type { ReactNode } from "react";

export interface FormFieldProps {
    label: string;
    htmlFor: string;
    error?: string | null;
    children: ReactNode;
}

export function FormField({ label, htmlFor, error, children }: FormFieldProps) {
    return (
        <div className={`form-field ${error ? "form-field-error" : ""}`}>
            <label htmlFor={htmlFor}>{label}</label>
            {children}
            {error ? (
                <p className="form-error" role="alert" data-testid="form-error">
                    {error}
                </p>
            ) : null}
        </div>
    );
}
