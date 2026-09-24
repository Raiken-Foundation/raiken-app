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
import { buildImpactCommandParts, shortSha } from "../helpers";

export function ImpactPanel() {
    const [base, setBase] = useState("");
    const [head, setHead] = useState("");
    const [staged, setStaged] = useState(false);
    const [threshold, setThreshold] = useState("0.1");
    const baseId = useId();
    const headId = useId();
    const thrId = useId();

    const mutation = trpc.runCi.useMutation();

    const submit = () => {
        const t = Number.parseFloat(threshold);
        mutation.mutate({
            base: base || undefined,
            head: head || undefined,
            staged,
            skipRun: true,
            confidenceThreshold: Number.isFinite(t) ? t : undefined,
        });
    };

    return (
        <article className="q-panel">
            <PanelHeader name="impact" brief={TOOLS[1].brief} />

            <CommandLine
                parts={buildImpactCommandParts({ base, head, staged, threshold })}
                onRun={submit}
                running={mutation.isPending}
                runLabel="compute"
            />

            <ArgsBlock>
                <ArgRow flag="--base" htmlFor={baseId} hint="defaults to origin/main">
                    <input
                        id={baseId}
                        type="text"
                        className="q-input"
                        value={base}
                        placeholder="origin/main"
                        onChange={(e) => setBase(e.target.value)}
                        disabled={staged}
                    />
                </ArgRow>
                <ArgRow flag="--head" htmlFor={headId} hint="defaults to HEAD">
                    <input
                        id={headId}
                        type="text"
                        className="q-input"
                        value={head}
                        placeholder="HEAD"
                        onChange={(e) => setHead(e.target.value)}
                        disabled={staged}
                    />
                </ArgRow>
                <ArgRow flag="--confidence" htmlFor={thrId} hint="floor (0..1)">
                    <input
                        id={thrId}
                        type="number"
                        className="q-input q-input--num"
                        min={0}
                        max={1}
                        step={0.05}
                        value={threshold}
                        onChange={(e) => setThreshold(e.target.value)}
                    />
                </ArgRow>
                <ToggleRow
                    flag="--staged"
                    checked={staged}
                    onChange={setStaged}
                    description="use the staged diff (pre-commit mode)"
                />
            </ArgsBlock>

            <ErrorLine error={mutation.error} />

            {mutation.data && (
                <StatusStrip
                    items={[
                        {
                            label: "changed",
                            value: mutation.data.impact.changedFiles.length,
                            tone: "muted",
                        },
                        {
                            label: "considered",
                            value: mutation.data.impact.consideredSourceFiles.length,
                            tone: "muted",
                        },
                        {
                            label: "affected",
                            value: mutation.data.impact.affectedTests.length,
                            tone: mutation.data.impact.affectedTests.length > 0 ? "warn" : "ok",
                        },
                        {
                            label: "below floor",
                            value: mutation.data.impact.skippedBelowThreshold.length,
                            tone: "muted",
                        },
                    ]}
                    extra={
                        <span className="q-strip-cite">
                            {mutation.data.impact.refs.base}@
                            {shortSha(mutation.data.impact.refs.baseSha)} →{" "}
                            {mutation.data.impact.refs.head}@
                            {shortSha(mutation.data.impact.refs.headSha)}
                        </span>
                    }
                />
            )}

            <OutputPanel
                title="affected tests"
                rightMeta={
                    mutation.data ? <>{mutation.data.impact.affectedTests.length} match</> : null
                }
                empty={
                    mutation.isPending ? (
                        <Spinner label="walking the graph…" />
                    ) : (
                        <span>No impact computed yet.</span>
                    )
                }
            >
                {mutation.data &&
                    (mutation.data.impact.affectedTests.length === 0 ? (
                        <div className="q-out-empty">
                            <span className="q-ok-mark">✓</span> No tests above the confidence
                            floor.
                        </div>
                    ) : (
                        mutation.data.impact.affectedTests.map((t, i) => (
                            <StdoutLine key={t.testFile} n={i + 1}>
                                <div className="q-fnd-row">
                                    <span className="q-conf">
                                        {Math.round(t.confidence * 100)}%
                                    </span>
                                    <span className="q-fnd-loc">{t.testFile}</span>
                                </div>
                                <div className="q-fnd-msg q-fnd-msg--dim">
                                    triggered by {t.sourceFiles.length} source file
                                    {t.sourceFiles.length === 1 ? "" : "s"}
                                </div>
                                <pre className="q-fnd-snippet">{t.sourceFiles.join("\n")}</pre>
                            </StdoutLine>
                        ))
                    ))}
            </OutputPanel>
        </article>
    );
}
