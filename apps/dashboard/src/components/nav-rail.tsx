import { Logo } from "./logo";

type View = "testing" | "quality" | "contract";

/**
 * Attention flags surfaced as a small dot on the corresponding rail button —
 * the nav-rail equivalent of the REPL's startup banner. Booleans (not
 * counts) are intentional: the rail is 44px wide, there's no room for a
 * number, and "does this need a look" is all the badge needs to answer.
 */
interface NavRailAttention {
    /** At least one test file's last recorded run failed/errored/timed out. */
    files?: boolean;
    /** Discovery is paused/failed, or has unresolved blockers. */
    discovery?: boolean;
}

interface NavRailProps {
    activeView: View;
    sidebarCollapsed: boolean;
    onNavigate: (view: View) => void;
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
                className={`rail-btn ${activeView === "contract" ? "active" : ""}`}
                onClick={() => onNavigate("contract")}
                title={
                    attention?.discovery
                        ? "contract — acquisition (discovery) needs attention"
                        : "contract — observed behavior vs requirements"
                }
                aria-label={
                    attention?.discovery ? "contract, needs attention" : "contract"
                }
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    aria-hidden="true"
                >
                    <path d="M6 3h9l4 4v14H6z" />
                    <path d="M9 12h6M9 16h6" />
                </svg>
                <AttentionDot show={attention?.discovery} />
            </button>
            <button
                type="button"
                className={`rail-btn ${isOnTesting ? "active" : ""}`}
                onClick={() => onNavigate("testing")}
                title={attention?.files ? "tests — a test is failing" : "tests"}
                aria-label={attention?.files ? "tests, needs attention" : "tests"}
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

                .rail-btn {
                    transition: color 120ms cubic-bezier(0.25, 0.46, 0.45, 0.94),
                        background 120ms cubic-bezier(0.25, 0.46, 0.45, 0.94),
                        box-shadow 120ms cubic-bezier(0.25, 0.46, 0.45, 0.94);
                }
                .rail-btn.active {
                    color: var(--accent);
                    background: var(--bg);
                    box-shadow: 0 0 16px -6px var(--accent-dim);
                }
                .rail-btn.active::before {
                    content: "";
                    position: absolute;
                    left: 0;
                    top: 0;
                    bottom: 0;
                    width: 2px;
                    background: var(--accent);
                    box-shadow: 0 0 8px -1px var(--accent);
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
