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
    ToggleRow,
} from "../components/quality-primitives";
import { TOOLS } from "../constants";
import { buildCoverCommandParts } from "../helpers";

export function CoverPanel() {
    const [target, setTarget] = useState("");
    const [ticketId, setTicketId] = useState("");
    const [dryRun, setDryRun] = useState(false);
    const targetId = useId();
    const ticketIdInputId = useId();
    const mutation = trpc.runCover.useMutation();

    useEffect(() => {
        try {
            const prefill = sessionStorage.getItem("raiken.prefill.cover");
            if (prefill) {
                setTarget(prefill);
                sessionStorage.removeItem("raiken.prefill.cover");
            }
        } catch {
            // ignore
        }
    }, []);

    const submit = () => {
        if (!target.trim()) return;
        mutation.mutate({
            target: target.trim(),
            ticketId: ticketId.trim() || undefined,
            dryRun,
        });
    };

    return (
        <article className="q-panel">
            <PanelHeader name="cover" brief={TOOLS[3].brief} />

            <CommandLine
                parts={buildCoverCommandParts({ target, ticketId, dryRun })}
                onRun={submit}
                running={mutation.isPending}
                disabled={!target.trim()}
                runLabel="draft"
            />

            <ArgsBlock>
                <ArgRow flag="<target>" htmlFor={targetId} hint="scenario · AC id · symbol name">
                    <input
                        id={targetId}
                        type="text"
                        className="q-input"
                        value={target}
                        placeholder={`"User can reset password" — or AC-2 — or LoginForm`}
                        onChange={(e) => setTarget(e.target.value)}
                    />
                </ArgRow>
                <ArgRow flag="--ticket" htmlFor={ticketIdInputId} hint="defaults to current branch">
                    <input
                        id={ticketIdInputId}
                        type="text"
                        className="q-input"
                        value={ticketId}
                        placeholder="JIRA-123"
                        onChange={(e) => setTicketId(e.target.value)}
                    />
                </ArgRow>
                <ToggleRow
                    flag="--dry-run"
                    checked={dryRun}
                    onChange={setDryRun}
                    description="scaffold only — do not call the LLM"
                />
            </ArgsBlock>

            <ErrorLine error={mutation.error} />

            {mutation.data && (
                <StatusStrip
                    items={[
                        { label: "kind", value: mutation.data.kind, tone: "muted" },
                        { label: "bytes", value: mutation.data.bytesWritten, tone: "muted" },
                        {
                            label: "sources",
                            value: mutation.data.sourceFiles.length,
                            tone: "muted",
                        },
                    ]}
                    extra={
                        <span className="q-strip-cite">
                            wrote <span className="q-mono-em">{mutation.data.relativePath}</span>
                            {mutation.data.usedModel && (
                                <>
                                    {" · via "}
                                    <span className="q-mono-em">{mutation.data.usedModel}</span>
                                </>
                            )}
                        </span>
                    }
                />
            )}

            <OutputPanel
                title="sources consulted"
                empty={
                    mutation.isPending ? (
                        <Spinner label="composing spec…" />
                    ) : (
                        <span>No draft yet.</span>
                    )
                }
            >
                {mutation.data && mutation.data.sourceFiles.length > 0 && (
                    <StdoutLine n={1}>
                        <pre className="q-fnd-snippet">{mutation.data.sourceFiles.join("\n")}</pre>
                    </StdoutLine>
                )}
                {mutation.data && mutation.data.sourceFiles.length === 0 && (
                    <div className="q-out-empty">
                        <span className="q-ok-mark">✓</span> Spec drafted without external sources.
                    </div>
                )}
            </OutputPanel>
        </article>
    );
}
