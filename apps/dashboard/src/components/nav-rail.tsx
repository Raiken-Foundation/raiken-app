import { Logo } from "./logo";

/**
 * Two entries, two audiences: the Board (the Reader's status board — the
 * dashboard's front door) and the Workbench (contract · tests · quality,
 * the operator's screens, one click behind it). The workbench button
 * returns to the last workbench view instead of resetting to a default.
 */

interface NavRailAttention {
    /** At least one test file's last recorded run failed/errored/timed out. */
    files?: boolean;
    /** Discovery is paused/failed, or has unresolved blockers. */
    discovery?: boolean;
}

interface NavRailProps {
    activeView: "board" | "workbench";
    /** Which workbench view the Workbench button opens (contract/testing/quality). */
    workbenchView: "contract" | "testing" | "quality";
    onOpenWorkbench: () => void;
    onNavigate: (view: "board") => void;
    onToggleCollapse: () => void;
    sidebarCollapsed: boolean;
    attention?: NavRailAttention;
}

/** Small dot rendered in the top-right corner of a rail button. */
function AttentionDot({ show }: { show: boolean | undefined }) {
    if (!show) return null;
    return <span className="rail-dot" aria-hidden="true" />;
}

export function NavRail({
    activeView,
    workbenchView,
    onOpenWorkbench,
    onNavigate,
    onToggleCollapse,
    sidebarCollapsed,
    attention,
}: NavRailProps) {
    const onBoard = activeView === "board";
    const workbenchNeedsAttention = attention?.files || attention?.discovery;
    const workbenchLabel = `workbench (${workbenchView})`;

    return (
        <nav className="nav-rail" aria-label="Main navigation">
            <div className="rail-brand" title="Raiken">
                <Logo size={18} />
            </div>
            <button
                type="button"
                className={`rail-btn ${onBoard ? "active" : ""}`}
                onClick={() => onNavigate("board")}
                title="status board — does what we promised work?"
                aria-label="status board"
                aria-current={onBoard ? "page" : undefined}
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    aria-hidden="true"
                >
                    <path d="M4 5h16v14H4z" />
                    <path d="M8 10h8M8 14h5" />
                </svg>
            </button>
            <button
                type="button"
                className={`rail-btn ${activeView === "workbench" ? "active" : ""}`}
                onClick={onOpenWorkbench}
                title={
                    workbenchNeedsAttention
                        ? `${workbenchLabel} — needs attention`
                        : `${workbenchLabel} — contract, tests, quality`
                }
                aria-label={
                    workbenchNeedsAttention ? `${workbenchLabel}, needs attention` : workbenchLabel
                }
                aria-current={activeView === "workbench" ? "page" : undefined}
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    aria-hidden="true"
                >
                    <path d="M14 6l3.5 3.5L8 19H4.5v-3.5L14 6z" />
                    <path d="M5 9V5h4" />
                    <path d="M15 15v4h4" />
                </svg>
                <AttentionDot show={workbenchNeedsAttention} />
            </button>

            {activeView === "workbench" && workbenchView === "testing" && (
                <button
                    type="button"
                    className="rail-btn collapse-btn"
                    onClick={onToggleCollapse}
                    title={sidebarCollapsed ? "expand sidebar" : "collapse sidebar"}
                    aria-label={sidebarCollapsed ? "expand sidebar" : "collapse sidebar"}
                >
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        aria-hidden="true"
                    >
                        <path d={sidebarCollapsed ? "M9 5l7 7-7 7" : "M15 19l-7-7 7-7"} />
                    </svg>
                </button>
            )}

            <style>{`
                .nav-rail {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    width: 44px;
                    min-width: 44px;
                    padding: 0;
                    background: var(--bg-bar);
                    border-right: 1px solid var(--hair);
                    flex-shrink: 0;
                }

                .rail-brand {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 100%;
                    height: 28px;
                    border-bottom: 1px solid var(--hair);
                    flex-shrink: 0;
                }

                .rail-btn {
                    position: relative;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 100%;
                    height: 40px;
                    border: 0;
                    border-left: 2px solid transparent;
                    background: transparent;
                    color: var(--ink-dim);
                    cursor: pointer;
                }

                .rail-btn svg {
                    width: 17px;
                    height: 17px;
                }

                .rail-btn:hover {
                    color: var(--ink);
                    background: var(--bg-hover);
                }

                .rail-btn:focus-visible {
                    outline: 2px solid var(--accent);
                    outline-offset: -2px;
                }

                .rail-btn.active {
                    color: var(--accent);
                    border-left-color: var(--accent);
                    background: var(--accent-soft);
                }

                .rail-dot {
                    position: absolute;
                    top: 7px;
                    right: 7px;
                    width: 6px;
                    height: 6px;
                    border-radius: 50%;
                    background: var(--warn);
                    box-shadow: 0 0 0 2px var(--bg-bar);
                }

                .rail-spacer {
                    flex: 1;
                }

                .collapse-btn {
                    margin-top: auto;
                }
            `}</style>
        </nav>
    );
}
