import { useEffect, useId, useState } from "react";
import { trpc } from "../../../utils/trpc";
import {
    ArgRow,
    ArgsBlock,
    CommandLine,
    ErrorLine,
    OutputPanel,
    PanelHeader,
    Spinner,
    StatusStrip,
    StdoutLine,
} from "../components/quality-primitives";
import { TOOLS } from "../constants";
import { buildTraceCommandParts } from "../helpers";

export function TracePanel() {
    const [trace, setTrace] = useState("");
    const [minConfidence, setMinConfidence] = useState("0");
    const traceId = useId();
    const minId = useId();

    useEffect(() => {
        try {
            const prefill = sessionStorage.getItem("raiken.prefill.trace");
            if (prefill) {
                setTrace(prefill);
                sessionStorage.removeItem("raiken.prefill.trace");
            }
        } catch {
            // ignore
        }
    }, []);

    const query = trpc.queryTrace.useQuery(
        {
            trace,
            minConfidence: Number.parseFloat(minConfidence) || 0,
            limit: 20,
        },
        { enabled: false, retry: false },
    );

    return (
        <article className="q-panel">
            <PanelHeader name="trace" brief={TOOLS[2].brief} />

            <CommandLine
                parts={buildTraceCommandParts(minConfidence)}
                onRun={() => query.refetch()}
                running={query.isFetching}
                disabled={!trace.trim()}
                runLabel="resolve"
            />

            <ArgsBlock>
                <ArgRow flag="--stdin" htmlFor={traceId} hint="paste a stack trace">
                    <textarea
                        id={traceId}
                        rows={8}
                        className="q-textarea"
                        value={trace}
                        placeholder={
                            "Error: ...\n    at handler (src/server/api.ts:42:11)\n    at ..."
                        }
                        onChange={(e) => setTrace(e.target.value)}
                    />
                </ArgRow>
                <ArgRow flag="--confidence" htmlFor={minId} hint="floor (0..1)">
                    <input
                        id={minId}
                        type="number"
                        className="q-input q-input--num"
                        min={0}
                        max={1}
                        step={0.05}
                        value={minConfidence}
                        onChange={(e) => setMinConfidence(e.target.value)}
                    />
                </ArgRow>
            </ArgsBlock>

            <ErrorLine error={query.error} />

            {query.data && (
                <StatusStrip
                    items={[
                        { label: "frames", value: query.data.frames.length, tone: "muted" },
                        {
                            label: "in-project",
                            value: query.data.projectFrames.length,
                            tone: query.data.projectFrames.length > 0 ? "ok" : "warn",
                        },
                        {
                            label: "matches",
                            value: query.data.matches.length,
                            tone: query.data.matches.length > 0 ? "ok" : "muted",
                        },
                    ]}
                />
            )}

            <OutputPanel
                title="covering tests"
                empty={
                    query.isFetching ? (
                        <Spinner label="resolving frames…" />
                    ) : (
                        <span>Paste a trace and run.</span>
                    )
                }
            >
                {query.data &&
                    (query.data.projectFrames.length === 0 ? (
                        <div className="q-out-empty">
                            <span className="q-warn-mark">!</span> No frames pointed inside this
                            project.
                        </div>
                    ) : query.data.matches.length === 0 ? (
                        <div className="q-out-empty">No tests met the confidence floor.</div>
                    ) : (
                        query.data.matches.map((m, i) => (
                            <StdoutLine key={m.testFile} n={i + 1}>
                                <div className="q-fnd-row">
                                    <span className="q-conf">
                                        {Math.round(m.confidence * 100)}%
                                    </span>
                                    <span className="q-fnd-loc">{m.testFile}</span>
                                </div>
                                <div className="q-fnd-msg q-fnd-msg--dim">
                                    matched via {m.matchedFrames.length} frame
                                    {m.matchedFrames.length === 1 ? "" : "s"}
                                </div>
                                <pre className="q-fnd-snippet">{m.matchedFrames.join("\n")}</pre>
                            </StdoutLine>
                        ))
                    ))}
            </OutputPanel>
        </article>
    );
}
