import { SECTIONS } from "./constants";
import type { Section } from "./types";

export function SettingsNav({
    activeSection,
    onSelect,
}: {
    activeSection: Section;
    onSelect: (section: Section) => void;
}) {
    return (
        <nav className="settings-nav" aria-label="Settings sections">
            {SECTIONS.map((s) => (
                <button
                    key={s.id}
                    type="button"
                    className={`nav-item ${activeSection === s.id ? "active" : ""}`}
                    onClick={() => onSelect(s.id)}
                >
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        aria-hidden="true"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d={s.icon} />
                    </svg>
                    {s.label}
                </button>
            ))}
        </nav>
    );
}
