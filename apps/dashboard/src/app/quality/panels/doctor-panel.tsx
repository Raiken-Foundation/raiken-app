import { useId, useState } from "react";
import { trpc } from "../../../utils/trpc";
import {
    ArgRow,
    ArgsBlock,
    CommandLine,
    ErrorLine,
    OutputPanel,
    PanelHeader,
    SevTag,
    Spinner,
    StatusStrip,
    StdoutLine,
} from "../components/quality-primitives";
import { TOOLS } from "../constants";
import { buildDoctorCommandParts } from "../helpers";

export function DoctorPanel() {
    const [testDir, setTestDir] = useState("");
    const dirId = useId();
    const query = trpc.runDoctor.useQuery(
        { testDirectory: testDir || undefined },
        { enabled: false, retry: false },
    );

    return (
        <article className="q-panel">
            <PanelHeader name="doctor" brief={TOOLS[0].brief} />

            <CommandLine
                parts={buildDoctorCommandParts(testDir)}
                onRun={() => query.refetch()}
                running={query.isFetching}
                runLabel="audit"
            />

            <ArgsBlock>
                <ArgRow flag="--test-dir" htmlFor={dirId} hint="defaults to project config">
                    <input
                        id={dirId}
                        type="text"
                        className="q-input"
                        value={testDir}
                        placeholder="e2e"
                        onChange={(e) => setTestDir(e.target.value)}
                    />
                </ArgRow>
            </ArgsBlock>

            <ErrorLine error={query.error} />

            {query.data && (
                <StatusStrip
                    items={[
                        { label: "files", value: query.data.scannedFiles, tone: "muted" },
                        {
                            label: "errors",
                            value: query.data.summary.error,
                            tone: query.data.summary.error > 0 ? "fail" : "ok",
                        },
                        {
                            label: "warnings",
                            value: query.data.summary.warning,
                            tone: query.data.summary.warning > 0 ? "warn" : "ok",
                        },
                        { label: "notes", value: query.data.summary.info, tone: "muted" },
                    ]}
                />
            )}

            <OutputPanel
                title="stdout"
                rightMeta={
                    query.data ? (
                        <>
                            {query.data.findings.length} finding
                            {query.data.findings.length === 1 ? "" : "s"}
                        </>
                    ) : null
                }
                empty={
                    query.isFetching ? (
                        <Spinner label="scanning specs…" />
                    ) : (
                        <span>No audit yet. Press run.</span>
                    )
                }
            >
                {query.data &&
                    (query.data.findings.length === 0 ? (
                        <div className="q-out-empty">
                            <span className="q-ok-mark">✓</span> Suite is clean.
                        </div>
                    ) : (
                        query.data.findings.map((f, i) => (
                            <StdoutLine key={`${f.file}:${f.line}:${f.column}:${i}`} n={i + 1}>
                                <div className="q-fnd-row">
                                    <SevTag level={f.severity} />
                                    <span className="q-fnd-rule">{f.rule}</span>
                                    <span className="q-fnd-loc">
                                        {f.file}:{f.line}:{f.column}
                                    </span>
                                </div>
                                <div className="q-fnd-msg">{f.message}</div>
                                {f.snippet && <pre className="q-fnd-snippet">{f.snippet}</pre>}
                                <div className="q-fnd-fix">
                                    <span className="q-fnd-fix-tag">fix</span> {f.suggestion}
                                </div>
                            </StdoutLine>
                        ))
                    ))}
            </OutputPanel>
        </article>
    );
}
