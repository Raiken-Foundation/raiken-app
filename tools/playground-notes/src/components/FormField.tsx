import type { ReactNode } from "react";

interface FormFieldProps {
    label: string;
    htmlFor: string;
    error?: string;
    children: ReactNode;
}

export function FormField({ label, htmlFor, error, children }: FormFieldProps) {
    return (
        <div className="form-field" data-testid={`field-${htmlFor}`}>
            <label htmlFor={htmlFor}>{label}</label>
            {children}
            {error && (
                <span className="form-error" data-testid="form-error">
                    {error}
                </span>
            )}
        </div>
    );
}
