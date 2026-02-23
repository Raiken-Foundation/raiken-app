type View = "testing" | "discovery" | "settings";
type SidebarTab = "chat" | "files";

interface NavRailProps {
    activeView: View;
    activeSidebarTab: SidebarTab;
    sidebarCollapsed: boolean;
    onNavigate: (view: View, tab?: SidebarTab) => void;
    onToggleCollapse: () => void;
}

export function NavRail({
    activeView,
    activeSidebarTab,
    sidebarCollapsed,
    onNavigate,
    onToggleCollapse,
}: NavRailProps) {
    const isOnTesting = activeView === "testing";

    return (
        <nav className="nav-rail" role="navigation" aria-label="Main navigation">
            <button
                className={`rail-btn ${isOnTesting && activeSidebarTab === "chat" ? "active" : ""}`}
                onClick={() => onNavigate("testing", "chat")}
                title="Chat"
            >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                    <rect x="4" y="4" width="16" height="14" rx="3" />
                    <path d="M8 9h8M8 13h5" />
                </svg>
            </button>
            <button
                className={`rail-btn ${isOnTesting && activeSidebarTab === "files" ? "active" : ""}`}
                onClick={() => onNavigate("testing", "files")}
                title="Files"
            >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                    <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
            </button>
            <button
                className={`rail-btn ${activeView === "discovery" ? "active" : ""}`}
                onClick={() => onNavigate("discovery")}
                title="Discovery"
            >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M14.8 9.2l-2.1 5.6-3.5 1.2 1.2-3.5 4.4-3.3z" />
                </svg>
            </button>
            <button
                className={`rail-btn settings-btn ${activeView === "settings" ? "active" : ""}`}
                onClick={() => onNavigate("settings")}
                title="Settings"
            >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                    <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
            </button>

            {isOnTesting && (
                <button
                    className="rail-btn collapse-btn"
                    onClick={onToggleCollapse}
                    title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                        <path d={sidebarCollapsed ? "M9 5l7 7-7 7" : "M15 19l-7-7 7-7"} />
                    </svg>
                </button>
            )}

            <style>{`
                .nav-rail {
                    display: flex;
                    flex-direction: column;
                    width: 56px;
                    min-width: 56px;
                    padding: 0.75rem 0.5rem;
                    gap: 0.25rem;
                    background: #0f0f0f;
                    border-right: 1px solid #1f1f1f;
                    flex-shrink: 0;
                }

                .rail-btn {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 40px;
                    height: 40px;
                    background: transparent;
                    border: none;
                    border-radius: 4px;
                    color: #6b7280;
                    cursor: pointer;
                    transition: all 0.15s;
                }

                .rail-btn:hover {
                    background: #1f1f1f;
                    color: #9ca3af;
                }

                .rail-btn.active {
                    background: #1f1f1f;
                    color: #3b82f6;
                }

                .rail-btn.settings-btn {
                    margin-top: auto;
                }

                .rail-btn.collapse-btn {
                    margin-top: 0.5rem;
                }

                .rail-btn.collapse-btn:hover {
                    color: #e5e7eb;
                }

                .rail-btn svg {
                    width: 1.25rem;
                    height: 1.25rem;
                }
            `}</style>
        </nav>
    );
}
