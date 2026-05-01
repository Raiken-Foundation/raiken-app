import type { ReactNode } from "react";

export interface TabDefinition {
    id: string;
    label: string;
    badge?: string | number;
}

interface TabsProps {
    tabs: TabDefinition[];
    activeId: string;
    onSelect: (id: string) => void;
    children: ReactNode;
}

export default function Tabs({ tabs, activeId, onSelect, children }: TabsProps) {
    return (
        <div className="tabs" data-testid="tabs">
            <div className="tab-list" role="tablist">
                {tabs.map((tab) => (
                    <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={activeId === tab.id}
                        className={`tab ${activeId === tab.id ? "tab-active" : ""}`}
                        onClick={() => onSelect(tab.id)}
                        data-testid={`tab-${tab.id}`}
                    >
                        <span>{tab.label}</span>
                        {tab.badge !== undefined && tab.badge !== "" && (
                            <span className="tab-badge">{tab.badge}</span>
                        )}
                    </button>
                ))}
            </div>
            <div className="tab-panel" role="tabpanel" data-testid={`tab-panel-${activeId}`}>
                {children}
            </div>
        </div>
    );
}
