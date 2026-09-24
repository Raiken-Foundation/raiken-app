export function Skeleton({ lines = 3 }: { lines?: number }) {
    return (
        <div className="skeleton-block" data-testid="skeleton" aria-hidden="true">
            {Array.from({ length: lines }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton lines
                <div key={i} className="skeleton-line" />
            ))}
        </div>
    );
}
