import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Logo } from "../components/logo";
import { trpc } from "../utils/trpc";

// =============================================================================
// Quality view — a programmer's tool, not a magazine.
//   Five Raiken commands, each rendered as the CLI invocation it actually is:
//   a `$ raiken <cmd> --flag value` line, an arg list, and a terminal-style
//   stdout panel. Flat dark palette, JetBrains Mono, single purple accent —
//   matches the in-app code editor.
// =============================================================================

type ToolId = "doctor" | "impact" | "trace" | "cover" | "context";

const TOOLS: { id: ToolId; label: string; brief: string }[] = [
    {
        id: "doctor",
        label: "doctor",
        brief: "Static audit of your e2e suite for the patterns that cause flakes.",
    },
    {
        id: "impact",
        label: "impact",
        brief: "Tests affected by the current diff, ranked by graph confidence.",
    },
    {
        id: "trace",
        label: "trace",
        brief: "Reverse a stack trace into the existing tests that exercise that path.",
    },
    {
        id: "cover",
        label: "cover",
        brief: "Draft a Playwright spec from a scenario, AC id, or symbol name.",
    },
    {
        id: "context",
        label: "context",
        brief: "Write raiken.ctx.md — a portable briefing for IDE agents.",
    },
];

function getToolFromHash(): ToolId {
    const m = window.location.hash.match(/#\/quality\/([a-z]+)/);
    const id = m?.[1] as ToolId | undefined;
    return TOOLS.some((t) => t.id === id) ? (id as ToolId) : "doctor";
}

export function QualityView() {
    const projectQuery = trpc.getProjectInfo.useQuery();
    const projectName = useMemo(() => {
        const p = projectQuery.data?.path;
        if (!p) return "—";
        const parts = p.split("/").filter(Boolean);
        return parts[parts.length - 1] || p;
    }, [projectQuery.data]);

    const [active, setActive] = useState<ToolId>(() =>
        typeof window === "undefined" ? "doctor" : getToolFromHash(),
    );

    useEffect(() => {
        const onHash = () => setActive(getToolFromHash());
        window.addEventListener("hashchange", onHash);
        return () => window.removeEventListener("hashchange", onHash);
    }, []);

    const select = useCallback((id: ToolId) => {
        setActive(id);
        window.location.hash = `#/quality/${id}`;
    }, []);

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
                    <span>5 tools</span>
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

// -----------------------------------------------------------------------------
// Building blocks
// -----------------------------------------------------------------------------

function PanelHeader({ name, brief }: { name: string; brief: string }) {
    return (
        <header className="q-head">
            <h2 className="q-head-title">
                <span className="q-head-hash" aria-hidden="true">
                    #
                </span>
                {name}
            </h2>
            <p className="q-head-brief">{brief}</p>
        </header>
    );
}

function CommandLine({
    parts,
    onRun,
    running,
    disabled,
    runLabel = "run",
    shortcut,
}: {
    parts: string[];
    onRun: () => void;
    running?: boolean;
    disabled?: boolean;
    runLabel?: string;
    shortcut?: string;
}) {
    return (
        <div className="q-cmd">
            <div className="q-cmd-line">
                <span className="q-cmd-prompt" aria-hidden="true">
                    $
                </span>
                <code className="q-cmd-text">
                    <span className="q-cmd-bin">raiken</span>
                    {parts.map((p) => (
                        <span key={p} className={p.startsWith("--") ? "q-cmd-flag" : "q-cmd-arg"}>
                            {" "}
                            {p}
                        </span>
                    ))}
                </code>
            </div>
            <button
                type="button"
                className="q-run"
                onClick={onRun}
                disabled={disabled || running}
                aria-label={running ? "running" : `${runLabel}${shortcut ? ` (${shortcut})` : ""}`}
                title={running ? "running" : `${runLabel}${shortcut ? ` (${shortcut})` : ""}`}
            >
                {running ? (
                    <>
                        <span className="q-run-spin" aria-hidden="true" />
                        <span className="q-run-label">running</span>
                    </>
                ) : (
                    <>
                        <span className="q-run-glyph" aria-hidden="true">
                            ▶
                        </span>
                        <span className="q-run-label">{runLabel}</span>
                        {shortcut && <kbd className="q-run-kbd">{shortcut}</kbd>}
                    </>
                )}
            </button>
        </div>
    );
}

function ArgRow({
    flag,
    htmlFor,
    children,
    hint,
}: {
    flag: string;
    htmlFor?: string;
    children: React.ReactNode;
    hint?: string;
}) {
    return (
        <div className="q-arg">
            <label className="q-arg-flag" htmlFor={htmlFor}>
                {flag}
            </label>
            <div className="q-arg-input">{children}</div>
            {hint && <span className="q-arg-hint">{hint}</span>}
        </div>
    );
}

function ArgsBlock({ children }: { children: React.ReactNode }) {
    return <div className="q-args">{children}</div>;
}

function ToggleRow({
    flag,
    checked,
    onChange,
    description,
}: {
    flag: string;
    checked: boolean;
    onChange: (v: boolean) => void;
    description: string;
}) {
    const id = useId();
    return (
        <div className="q-arg q-arg--toggle">
            <label className="q-arg-flag" htmlFor={id}>
                {flag}
            </label>
            <div className="q-arg-input">
                <label className="q-toggle">
                    <input
                        id={id}
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => onChange(e.target.checked)}
                    />
                    <span className="q-toggle-mark" aria-hidden="true" />
                    <span className="q-toggle-text">{description}</span>
                </label>
            </div>
        </div>
    );
}

function ErrorLine({ error }: { error: unknown }) {
    if (!error) return null;
    const msg =
        error instanceof Error
            ? error.message
            : typeof error === "object" && error !== null && "message" in error
              ? String((error as { message: unknown }).message)
              : String(error);
    return (
        <output className="q-err" role="alert">
            <span className="q-err-tag">ERR</span>
            <span className="q-err-msg">{msg}</span>
        </output>
    );
}

function StatusStrip({
    items,
    extra,
}: {
    items: { label: string; value: number | string; tone?: "ok" | "warn" | "fail" | "muted" }[];
    extra?: React.ReactNode;
}) {
    return (
        <div className="q-strip">
            {items.map((it) => (
                <span key={it.label} className={`q-strip-item q-strip-item--${it.tone || "muted"}`}>
                    <span className="q-strip-val">{it.value}</span>
                    <span className="q-strip-label">{it.label}</span>
                </span>
            ))}
            {extra && <span className="q-strip-extra">{extra}</span>}
        </div>
    );
}

function OutputPanel({
    title,
    rightMeta,
    children,
    empty,
}: {
    title: string;
    rightMeta?: React.ReactNode;
    children?: React.ReactNode;
    empty?: React.ReactNode;
}) {
    return (
        <section className="q-out">
            <header className="q-out-head">
                <span className="q-out-title">{title}</span>
                {rightMeta && <span className="q-out-meta">{rightMeta}</span>}
            </header>
            <div className="q-out-body">
                {children || <div className="q-out-empty">{empty}</div>}
            </div>
        </section>
    );
}

function StdoutLine({ n, children }: { n: number; children: React.ReactNode }) {
    return (
        <div className="q-line">
            <span className="q-line-n" aria-hidden="true">
                {String(n).padStart(3, "0")}
            </span>
            <div className="q-line-body">{children}</div>
        </div>
    );
}

function SevTag({ level }: { level: "error" | "warning" | "info" }) {
    const text = level === "error" ? "CRIT" : level === "warning" ? "WARN" : "NOTE";
    return <span className={`q-sev q-sev--${level}`}>{text}</span>;
}

function Spinner({ label }: { label: string }) {
    return (
        <div className="q-spin-row">
            <span className="q-spin" aria-hidden="true" />
            <span>{label}</span>
        </div>
    );
}

// -----------------------------------------------------------------------------
// doctor
// -----------------------------------------------------------------------------

function DoctorPanel() {
    const [testDir, setTestDir] = useState("");
    const dirId = useId();
    const query = trpc.runDoctor.useQuery(
        { testDirectory: testDir || undefined },
        { enabled: false, retry: false },
    );

    const cmd = ["doctor"];
    if (testDir.trim()) cmd.push("--test-dir", testDir.trim());

    return (
        <article className="q-panel">
            <PanelHeader name="doctor" brief={TOOLS[0].brief} />

            <CommandLine
                parts={cmd}
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

// -----------------------------------------------------------------------------
// impact
// -----------------------------------------------------------------------------

function ImpactPanel() {
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

    const cmd = ["ci", "--skip-run"];
    if (staged) cmd.push("--staged");
    else {
        if (base.trim()) cmd.push("--base", base.trim());
        if (head.trim()) cmd.push("--head", head.trim());
    }
    if (threshold.trim() && threshold !== "0.1") cmd.push("--confidence", threshold.trim());

    return (
        <article className="q-panel">
            <PanelHeader name="impact" brief={TOOLS[1].brief} />

            <CommandLine
                parts={cmd}
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
                            {short(mutation.data.impact.refs.baseSha)} →{" "}
                            {mutation.data.impact.refs.head}@
                            {short(mutation.data.impact.refs.headSha)}
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

// -----------------------------------------------------------------------------
// trace
// -----------------------------------------------------------------------------

function TracePanel() {
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

    const cmd = ["trace", "--stdin"];
    if (minConfidence !== "0") cmd.push("--confidence", minConfidence);

    return (
        <article className="q-panel">
            <PanelHeader name="trace" brief={TOOLS[2].brief} />

            <CommandLine
                parts={cmd}
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

// -----------------------------------------------------------------------------
// cover
// -----------------------------------------------------------------------------

function CoverPanel() {
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

    const cmd = ["cover"];
    if (target.trim()) cmd.push(`"${target.trim()}"`);
    else cmd.push("<target>");
    if (ticketId.trim()) cmd.push("--ticket", ticketId.trim());
    if (dryRun) cmd.push("--dry-run");

    return (
        <article className="q-panel">
            <PanelHeader name="cover" brief={TOOLS[3].brief} />

            <CommandLine
                parts={cmd}
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

// -----------------------------------------------------------------------------
// context
// -----------------------------------------------------------------------------

function ContextPanel() {
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

    const cmd = ["context"];
    if (maxRows && maxRows !== "25") cmd.push("--max-rows", maxRows);
    if (!includeImpact) cmd.push("--no-impact");

    return (
        <article className="q-panel">
            <PanelHeader name="context" brief={TOOLS[4].brief} />

            <CommandLine parts={cmd} onRun={submit} running={mutation.isPending} runLabel="write" />

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

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function short(sha: string): string {
    return sha ? sha.slice(0, 7) : "—";
}

export default QualityView;
