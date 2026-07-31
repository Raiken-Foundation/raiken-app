import { shortenUrl } from "../helpers";
import type { BrokenLinkRow, VerifiedLinkRow } from "../types";

interface LinksListProps {
    variant: "verified" | "broken";
    verifiedLinks: VerifiedLinkRow[];
    brokenLinks: BrokenLinkRow[];
}

export function LinksList({ variant, verifiedLinks, brokenLinks }: LinksListProps) {
    if (variant === "verified") {
        if (verifiedLinks.length === 0) {
            return <p className="empty">No verified paths yet.</p>;
        }
        return (
            <div className="links-list">
                {verifiedLinks.map((link, i) => (
                    <div key={`v-${i}`} className="link-row">
                        <div className="link-path">
                            <span className="link-from" title={link.fromUrl}>
                                {shortenUrl(link.fromUrl)}
                            </span>
                            <svg
                                className="link-arrow"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                aria-hidden="true"
                            >
                                <path d="M5 12h14m-4-4l4 4-4 4" />
                            </svg>
                            <span className="link-to" title={link.toUrl}>
                                {shortenUrl(link.toUrl)}
                            </span>
                        </div>
                        <div className="link-meta">
                            {link.selector && (
                                <code className="link-selector">{link.selector}</code>
                            )}
                            {link.linkText && <span className="link-text">{link.linkText}</span>}
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    if (brokenLinks.length === 0) {
        return <p className="empty">No broken links detected.</p>;
    }

    return (
        <div className="links-list">
            {brokenLinks.map((link, i) => (
                <div key={`b-${i}`} className="link-row broken">
                    <div className="link-path">
                        <span className="link-from" title={link.fromUrl}>
                            {shortenUrl(link.fromUrl)}
                        </span>
                        <svg
                            className="link-arrow"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            aria-hidden="true"
                        >
                            <path d="M5 12h14m-4-4l4 4-4 4" />
                        </svg>
                        <span className="link-to broken-url" title={link.toUrl}>
                            {shortenUrl(link.toUrl)}
                        </span>
                    </div>
                    {link.errorMessage && <span className="link-error">{link.errorMessage}</span>}
                </div>
            ))}
        </div>
    );
}
