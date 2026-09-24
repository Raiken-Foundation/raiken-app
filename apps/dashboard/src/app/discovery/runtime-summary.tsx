import { formatDate } from "./helpers";

interface RuntimeSummaryProps {
    phase: string | undefined;
    pagesCount: number;
    linksCount: number;
    verifiedLinksCount: number;
    brokenLinksCount: number;
    unresolvedBlockersCount: number;
    authBlockersFound: number | undefined;
    latestSession: {
        status: string;
        completedAt?: string | null;
        blockedAtUrl?: string | null;
    } | null;
}

export function RuntimeSummary({
    phase,
    pagesCount,
    linksCount,
    verifiedLinksCount,
    brokenLinksCount,
    unresolvedBlockersCount,
    authBlockersFound,
    latestSession,
}: RuntimeSummaryProps) {
    return (
        <section className="card">
            <h2 className="card-title">Status</h2>
            <div className="stat-grid">
                <div className="stat">
                    <span className="stat-label">Phase</span>
                    <span className={`stat-value phase-${phase ?? "idle"}`}>{phase ?? "idle"}</span>
                </div>
                <div className="stat">
                    <span className="stat-label">Pages</span>
                    <span className="stat-value">{pagesCount}</span>
                </div>
                <div className="stat">
                    <span className="stat-label">Links</span>
                    <span className="stat-value">{linksCount}</span>
                </div>
                <div className="stat">
                    <span className="stat-label">Verified</span>
                    <span className="stat-value clr-ok">{verifiedLinksCount}</span>
                </div>
                <div className="stat">
                    <span className="stat-label">Broken</span>
                    <span className="stat-value clr-err">{brokenLinksCount}</span>
                </div>
                <div className="stat">
                    <span className="stat-label">Blockers</span>
                    <span className={`stat-value ${unresolvedBlockersCount > 0 ? "clr-warn" : ""}`}>
                        {unresolvedBlockersCount || authBlockersFound || 0}
                    </span>
                </div>
            </div>

            {latestSession && (
                <div className="session-strip">
                    <span className="session-kv">
                        <span className="session-k">Session</span>
                        {latestSession.status}
                    </span>
                    {latestSession.completedAt && (
                        <span className="session-kv">
                            <span className="session-k">Completed</span>
                            {formatDate(latestSession.completedAt)}
                        </span>
                    )}
                    {latestSession.blockedAtUrl && (
                        <span className="session-kv">
                            <span className="session-k">Blocked at</span>
                            <span className="session-url">{latestSession.blockedAtUrl}</span>
                        </span>
                    )}
                </div>
            )}
        </section>
    );
}
