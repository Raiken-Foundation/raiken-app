export interface PaginationProps {
    page: number;
    pageCount: number;
    onChange: (page: number) => void;
}

export function Pagination({ page, pageCount, onChange }: PaginationProps) {
    if (pageCount <= 1) return null;
    return (
        <nav className="pagination" aria-label="Pagination">
            <button
                type="button"
                className="button button-ghost button-sm"
                disabled={page <= 1}
                onClick={() => onChange(page - 1)}
            >
                Previous
            </button>
            <span className="pagination-info" data-testid="pagination-info">
                Page {page} of {pageCount}
            </span>
            <button
                type="button"
                className="button button-ghost button-sm"
                disabled={page >= pageCount}
                onClick={() => onChange(page + 1)}
            >
                Next
            </button>
        </nav>
    );
}
