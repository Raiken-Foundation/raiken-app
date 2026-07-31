import { PAGES_PER_PAGE } from "../constants";
import { safeHttpUrl } from "../helpers";
import type { DiscoveredPageRow } from "../types";
import { PageSnapshotDrawer } from "./page-snapshot-drawer";

interface PagesTableProps {
    pages: DiscoveredPageRow[];
    pagesTotal: number;
    pagesHasMore: boolean;
    pageOffset: number;
    selectedPageUrl: string | null;
    snapshotLoading: boolean;
    snapshotJson: string | null | undefined;
    snapshotMeta: {
        url: string;
        depth: number;
        title?: string | null;
    } | null;
    showGenerateTest: boolean;
    onSelectPage: (url: string) => void;
    onCloseSnapshot: () => void;
    onPageOffsetChange: (offset: number) => void;
    onGenerateTest: (pageUrl: string) => void;
}

export function PagesTable({
    pages,
    pagesTotal,
    pagesHasMore,
    pageOffset,
    selectedPageUrl,
    snapshotLoading,
    snapshotJson,
    snapshotMeta,
    showGenerateTest,
    onSelectPage,
    onCloseSnapshot,
    onPageOffsetChange,
    onGenerateTest,
}: PagesTableProps) {
    return (
        <section className="dv-section">
            <div className="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>URL</th>
                            <th>Depth</th>
                            <th>Title</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {pages.length === 0 ? (
                            <tr>
                                <td colSpan={4} className="empty-cell">
                                    No pages discovered yet.
                                </td>
                            </tr>
                        ) : (
                            pages.map((page) => {
                                const pageHref = safeHttpUrl(page.url);
                                return (
                                    <tr key={`${page.url}-${page.depth}`}>
                                        <td className="url-cell" title={page.url}>
                                            {page.url}
                                        </td>
                                        <td>{page.depth}</td>
                                        <td>{page.title || "Untitled"}</td>
                                        <td>
                                            <div className="page-actions">
                                                <button
                                                    type="button"
                                                    className="table-action"
                                                    onClick={() => onSelectPage(page.url)}
                                                >
                                                    Snapshot
                                                </button>
                                                {pageHref && (
                                                    <a
                                                        className="table-action table-link"
                                                        href={pageHref}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                    >
                                                        Open
                                                    </a>
                                                )}
                                                {showGenerateTest && (
                                                    <button
                                                        type="button"
                                                        className="table-action generate"
                                                        onClick={() => onGenerateTest(page.url)}
                                                    >
                                                        Generate Test
                                                    </button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })
                        )}
                    </tbody>
                </table>
            </div>
            {pagesTotal > PAGES_PER_PAGE && (
                <div className="pagination">
                    <button
                        type="button"
                        className="btn sm"
                        disabled={pageOffset === 0}
                        onClick={() => onPageOffsetChange(Math.max(0, pageOffset - PAGES_PER_PAGE))}
                    >
                        Previous
                    </button>
                    <span className="page-info">
                        {pageOffset + 1}&ndash;
                        {Math.min(pageOffset + PAGES_PER_PAGE, pagesTotal)} of {pagesTotal}
                    </span>
                    <button
                        type="button"
                        className="btn sm"
                        disabled={!pagesHasMore}
                        onClick={() => onPageOffsetChange(pageOffset + PAGES_PER_PAGE)}
                    >
                        Next
                    </button>
                </div>
            )}
            {selectedPageUrl && (
                <PageSnapshotDrawer
                    selectedPageUrl={selectedPageUrl}
                    loading={snapshotLoading}
                    snapshotJson={snapshotJson}
                    meta={snapshotMeta}
                    onClose={onCloseSnapshot}
                />
            )}
        </section>
    );
}
