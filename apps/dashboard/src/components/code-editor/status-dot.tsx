import type { TestFile } from "./types";

export function StatusDot({ status }: { status: TestFile["status"] }) {
    return <span className={`ce-dot ce-dot--${status}`} aria-hidden="true" />;
}
