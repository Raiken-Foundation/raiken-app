import { useEffect, useRef, useState } from "react";

export interface SearchInputProps {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    debounceMs?: number;
    "aria-label"?: string;
    "data-testid"?: string;
}

export function SearchInput({
    value,
    onChange,
    placeholder,
    debounceMs = 400,
    ...rest
}: SearchInputProps) {
    const [draft, setDraft] = useState(value);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    useEffect(() => {
        setDraft(value);
    }, [value]);

    useEffect(() => {
        return () => {
            if (timer.current) clearTimeout(timer.current);
        };
    }, []);

    return (
        <input
            type="search"
            className="input search-input"
            value={draft}
            placeholder={placeholder}
            aria-label={rest["aria-label"] ?? "Search"}
            data-testid={rest["data-testid"]}
            onChange={(event) => {
                setDraft(event.target.value);
                if (timer.current) clearTimeout(timer.current);
                timer.current = setTimeout(() => onChange(event.target.value), debounceMs);
            }}
        />
    );
}
