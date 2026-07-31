import { useId, useState } from "react";
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
    ToggleRow,
} from "../components/quality-primitives";
import { TOOLS } from "../constants";
import { buildContextCommandParts } from "../helpers";

export function ContextPanel() {
    const [maxRows, setMaxRows] = useState("25");
    const [includeImpact, setIncludeImpact] = useState(true);
    const maxRowsId = useId();
    const mutation = trpc.writeContext.useMutation();

    const submit = () => {
        const n = Number.parseInt(maxRows, 10);
        mutation.mutate({
            maxRowsPerSection: Number.isFinite(n) ? n : undefined,
            includeImpact,
        });
    };

    return (
        <article className="q-panel">
            <PanelHeader name="context" brief={TOOLS[4].brief} />

            <CommandLine
                parts={buildContextCommandParts({ maxRows, includeImpact })}
                onRun={submit}
                running={mutation.isPending}
                runLabel="write"
            />

            <ArgsBlock>
                <ArgRow flag="--max-rows" htmlFor={maxRowsId} hint="per section (1..200)">
                    <input
                        id={maxRowsId}
                        type="number"
                        className="q-input q-input--num"
                        min={1}
                        max={200}
                        value={maxRows}
                        onChange={(e) => setMaxRows(e.target.value)}
                    />
                </ArgRow>
                <ToggleRow
                    flag="--include-impact"
                    checked={includeImpact}
                    onChange={setIncludeImpact}
                    description="include current-branch impact"
                />
            </ArgsBlock>

            <ErrorLine error={mutation.error} />

            {mutation.data && (
                <StatusStrip
                    items={[
                        { label: "bytes", value: mutation.data.bytesWritten, tone: "muted" },
                        {
                            label: "graph",
                            value: mutation.data.sections.graph ? "yes" : "no",
                            tone: mutation.data.sections.graph ? "ok" : "muted",
                        },
                        {
                            label: "impact",
                            value: mutation.data.sections.impact ? "yes" : "no",
                            tone: mutation.data.sections.impact ? "ok" : "muted",
                        },
                        {
                            label: "failures",
                            value: mutation.data.sections.failures ? "yes" : "no",
                            tone: mutation.data.sections.failures ? "ok" : "muted",
                        },
                        {
                            label: "coverage",
                            value: mutation.data.sections.coverage ? "yes" : "no",
                            tone: mutation.data.sections.coverage ? "ok" : "muted",
                        },
                    ]}
                    extra={
                        <span className="q-strip-cite">
                            wrote <span className="q-mono-em">{mutation.data.relativePath}</span>
                        </span>
                    }
                />
            )}

            <OutputPanel
                title="briefing"
                empty={
                    mutation.isPending ? (
                        <Spinner label="composing briefing…" />
                    ) : (
                        <span>No briefing written yet.</span>
                    )
                }
            >
                {mutation.data && (
                    <StdoutLine n={1}>
                        <div className="q-fnd-msg">
                            Wrote <span className="q-mono-em">{mutation.data.relativePath}</span> (
                            {mutation.data.bytesWritten} bytes).
                        </div>
                        <div className="q-fnd-msg q-fnd-msg--dim">
                            Paste this file into Cursor, Claude or Copilot for grounded answers
                            about the project's testing surface.
                        </div>
                    </StdoutLine>
                )}
            </OutputPanel>
        </article>
    );
}
