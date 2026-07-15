import { Logo } from "./logo";

type View = "testing" | "discovery" | "quality" | "settings";
type SidebarTab = "chat" | "files";

/**
 * Attention flags surfaced as a small dot on the corresponding rail button —
 * the nav-rail equivalent of the REPL's startup banner. Booleans (not
 * counts) are intentional: the rail is 44px wide, there's no room for a
 * number, and "does this need a look" is all the badge needs to answer.
 */
interface NavRailAttention {
    /** A `save_approval`/`run_approval` card is awaiting a decision. */
    chat?: boolean;
    /** At least one test file's last recorded run failed/errored/timed out. */
    files?: boolean;
    /** Discovery is paused/failed, or has unresolved blockers. */
    discovery?: boolean;
}

interface NavRailProps {
    activeView: View;
    activeSidebarTab: SidebarTab;
    sidebarCollapsed: boolean;
    onNavigate: (view: View, tab?: SidebarTab) => void;
    onToggleCollapse: () => void;
    attention?: NavRailAttention;
}

/** Small dot rendered in the top-right corner of a rail button. */
function AttentionDot({ show }: { show: boolean | undefined }) {
    if (!show) return null;
    return <span className="rail-dot" aria-hidden="true" />;
}

export function NavRail({
    activeView,
    activeSidebarTab,
    sidebarCollapsed,
    onNavigate,
    onToggleCollapse,
    attention,
}: NavRailProps) {
    const isOnTesting = activeView === "testing";

    return (
        <nav className="nav-rail" aria-label="Main navigation">
            <div className="rail-brand" title="Raiken">
                <Logo size={18} />
            </div>
            <button
                type="button"
                className={`rail-btn ${isOnTesting && activeSidebarTab === "chat" ? "active" : ""}`}
                onClick={() => onNavigate("testing", "chat")}
                title={attention?.chat ? "chat — waiting on your approval" : "chat"}
                aria-label={attention?.chat ? "chat, needs attention" : "chat"}
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    aria-hidden="true"
                >
                    <rect x="4" y="4" width="16" height="14" rx="3" />
                    <path d="M8 9h8M8 13h5" />
                </svg>
                <AttentionDot show={attention?.chat} />
            </button>
            <button
                type="button"
                className={`rail-btn ${isOnTesting && activeSidebarTab === "files" ? "active" : ""}`}
                onClick={() => onNavigate("testing", "files")}
                title={attention?.files ? "files — a test is failing" : "files"}
                aria-label={attention?.files ? "files, needs attention" : "files"}
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    aria-hidden="true"
                >
                    <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                <AttentionDot show={attention?.files} />
            </button>
            <button
                type="button"
                className={`rail-btn ${activeView === "discovery" ? "active" : ""}`}
                onClick={() => onNavigate("discovery")}
                title={attention?.discovery ? "discovery — needs attention" : "discovery"}
                aria-label={attention?.discovery ? "discovery, needs attention" : "discovery"}
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    aria-hidden="true"
                >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M14.8 9.2l-2.1 5.6-3.5 1.2 1.2-3.5 4.4-3.3z" />
                </svg>
                <AttentionDot show={attention?.discovery} />
            </button>
            <button
                type="button"
                className={`rail-btn ${activeView === "quality" ? "active" : ""}`}
                onClick={() => onNavigate("quality")}
                title="quality"
                aria-label="quality"
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    aria-hidden="true"
                >
                    <path d="M9 12l2 2 4-4" />
                    <path d="M12 2l9 4v6c0 5-3.5 9.5-9 10-5.5-.5-9-5-9-10V6l9-4z" />
                </svg>
            </button>
            <button
                type="button"
                className={`rail-btn settings-btn ${activeView === "settings" ? "active" : ""}`}
                onClick={() => onNavigate("settings")}
                title="settings"
                aria-label="settings"
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    aria-hidden="true"
                >
                    <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
            </button>

            {isOnTesting && (
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
                    height: 38px;
                    background: transparent;
                    border: 0;
                    color: var(--ink-faint);
                    cursor: pointer;
                    transition: color 0.12s, background 0.12s;
                    flex-shrink: 0;
                }

                .rail-btn:hover {
                    background: var(--bg-hover);
                    color: var(--ink-dim);
                }

                .rail-btn:focus-visible {
                    outline: 0;
                    box-shadow: inset 0 0 0 1px var(--accent);
                }

                .rail-btn.active {
                    color: var(--accent);
                    background: var(--bg);
                }
                .rail-btn.active::before {
                    content: "";
                    position: absolute;
                    left: 0;
                    top: 0;
                    bottom: 0;
                    width: 1px;
                    background: var(--accent);
                }

                .rail-btn.settings-btn {
                    margin-top: auto;
                    border-top: 1px solid var(--hair);
                }

                .rail-btn.collapse-btn {
                    border-top: 1px solid var(--hair);
                    color: var(--ink-mute);
                }
                .rail-btn.collapse-btn:hover {
                    color: var(--ink);
                }

                .rail-btn svg {
                    width: 16px;
                    height: 16px;
                }

                .rail-dot {
                    position: absolute;
                    top: 6px;
                    right: 9px;
                    width: 6px;
                    height: 6px;
                    border-radius: 50%;
                    background: var(--warn);
                    box-shadow: 0 0 0 1.5px var(--bg-bar);
                }
            `}</style>
        </nav>
    );
}
