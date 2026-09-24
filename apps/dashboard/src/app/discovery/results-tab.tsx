import type { ComponentProps } from "react";
import { LinksList } from "./results/links-list";
import { PagesTable } from "./results/pages-table";
import type { BrokenLinkRow, ResultsSubTab, VerifiedLinkRow } from "./types";

interface ResultsTabProps {
    resultsSubTab: ResultsSubTab;
    onResultsSubTabChange: (tab: ResultsSubTab) => void;
    pagesTotal: number;
    verifiedCount: number;
    brokenCount: number;
    pagesProps: ComponentProps<typeof PagesTable>;
    verifiedLinks: VerifiedLinkRow[];
    brokenLinks: BrokenLinkRow[];
}

export function ResultsTab({
    resultsSubTab,
    onResultsSubTabChange,
    pagesTotal,
    verifiedCount,
    brokenCount,
    pagesProps,
    verifiedLinks,
    brokenLinks,
}: ResultsTabProps) {
    return (
        <div className="tab-content">
            <div className="results-sub-tabs">
                <button
                    type="button"
                    className={`results-sub-tab ${resultsSubTab === "pages" ? "active" : ""}`}
                    onClick={() => onResultsSubTabChange("pages")}
                >
                    Pages
                    {pagesTotal > 0 && <span className="sub-badge">{pagesTotal}</span>}
                </button>
                <button
                    type="button"
                    className={`results-sub-tab ${resultsSubTab === "verified" ? "active" : ""}`}
                    onClick={() => onResultsSubTabChange("verified")}
                >
                    Verified
                    {verifiedCount > 0 && <span className="sub-badge good">{verifiedCount}</span>}
                </button>
                <button
                    type="button"
                    className={`results-sub-tab ${resultsSubTab === "broken" ? "active" : ""}`}
                    onClick={() => onResultsSubTabChange("broken")}
                >
                    Broken
                    {brokenCount > 0 && <span className="sub-badge bad">{brokenCount}</span>}
                </button>
            </div>

            {resultsSubTab === "pages" && <PagesTable {...pagesProps} />}

            {resultsSubTab === "verified" && (
                <LinksList variant="verified" verifiedLinks={verifiedLinks} brokenLinks={[]} />
            )}

            {resultsSubTab === "broken" && (
                <LinksList variant="broken" verifiedLinks={[]} brokenLinks={brokenLinks} />
            )}
        </div>
    );
}
