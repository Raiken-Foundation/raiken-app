import { Logo } from "../../components/logo";
import "./quality.css";
import { TOOLS } from "./constants";
import { ContextPanel } from "./panels/context-panel";
import { CoverPanel } from "./panels/cover-panel";
import { DoctorPanel } from "./panels/doctor-panel";
import { ImpactPanel } from "./panels/impact-panel";
import { TracePanel } from "./panels/trace-panel";
import { useQualityNavigation } from "./use-quality-navigation";

export function QualityScreen() {
    const { active, select, projectName } = useQualityNavigation();

    return (
        <div className="q-shell">
            <header className="q-statusbar">
                <span className="q-status-cell q-status-cell--brand">
                    <Logo size={12} bare />
                    <span>raiken/quality</span>
                </span>
                <span className="q-status-sep" aria-hidden="true">
                    /
                </span>
                <span className="q-status-cell">
                    <span className="q-status-key">project</span>
                    <span className="q-status-val">{projectName}</span>
                </span>
                <span className="q-status-spacer" />
                <span className="q-status-cell q-status-cell--muted">
                    <span>{TOOLS.length} tools</span>
                </span>
            </header>

            <nav className="q-tabs" aria-label="Quality tools">
                {TOOLS.map((t) => {
                    const isActive = t.id === active;
                    return (
                        <button
                            key={t.id}
                            type="button"
                            className={`q-tab ${isActive ? "is-active" : ""}`}
                            onClick={() => select(t.id)}
                            aria-current={isActive ? "page" : undefined}
                        >
                            <span className="q-tab-label">{t.label}</span>
                        </button>
                    );
                })}
            </nav>

            <main className="q-pane">
                {active === "doctor" && <DoctorPanel />}
                {active === "impact" && <ImpactPanel />}
                {active === "trace" && <TracePanel />}
                {active === "cover" && <CoverPanel />}
                {active === "context" && <ContextPanel />}
            </main>
        </div>
    );
}

export default QualityScreen;
