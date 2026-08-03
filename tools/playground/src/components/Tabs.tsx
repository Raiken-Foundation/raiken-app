export interface Tab {
    id: string;
    label: string;
    badge?: number;
}

export interface TabsProps {
    tabs: Tab[];
    active: string;
    onChange: (id: string) => void;
}

export function Tabs({ tabs, active, onChange }: TabsProps) {
    return (
        <div className="tabs" role="tablist">
            {tabs.map((tab) => (
                <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={tab.id === active}
                    className={`tab ${tab.id === active ? "tab-active" : ""}`}
                    onClick={() => onChange(tab.id)}
                >
                    {tab.label}
                    {tab.badge !== undefined && tab.badge > 0 ? (
                        <span className="tab-badge">{tab.badge}</span>
                    ) : null}
                </button>
            ))}
        </div>
    );
}
