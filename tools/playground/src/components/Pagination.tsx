interface PaginationProps {
    page: number;
    pageSize: number;
    total: number;
    onPageChange: (page: number) => void;
}

export default function Pagination({ page, pageSize, total, onPageChange }: PaginationProps) {
    const lastPage = Math.max(1, Math.ceil(total / pageSize));
    const showingFrom = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const showingTo = Math.min(page * pageSize, total);

    return (
        <nav className="pagination" aria-label="Pagination" data-testid="pagination">
            <span className="pagination-info" data-testid="pagination-info">
                {showingFrom}–{showingTo} of {total}
            </span>
            <div className="pagination-buttons">
                <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => onPageChange(Math.max(1, page - 1))}
                    disabled={page <= 1}
                    aria-label="Previous page"
                    data-testid="pagination-prev"
                >
                    ← Prev
                </button>
                <span className="pagination-current" data-testid="pagination-page">
                    Page {page} / {lastPage}
                </span>
                <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => onPageChange(Math.min(lastPage, page + 1))}
                    disabled={page >= lastPage}
                    aria-label="Next page"
                    data-testid="pagination-next"
                >
                    Next →
                </button>
            </div>
        </nav>
    );
}
