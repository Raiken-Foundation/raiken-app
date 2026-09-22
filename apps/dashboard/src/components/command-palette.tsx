import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "../utils/trpc";

interface Action {
    id: string;
    label: string;
    hint?: string;
    run: () => void;
}

/** Cmd+K action hub (Linear pattern): navigation + contract operations. */
export function CommandPalette({
    onNavigate,
}: {
    onNavigate: (view: "contract" | "testing" | "quality") => void;
}) {
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState("");
    const [sel, setSel] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const utils = trpc.useUtils();
    const verify = trpc.contractVerify.useMutation({ onSettled: () => void utils.contractView.invalidate() });
    const materialize = trpc.contractMaterialize.useMutation();
    const explore = trpc.contractExplore.useMutation({
        onSettled: () => void utils.contractView.invalidate(),
    });

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
                e.preventDefault();
                setOpen((v) => !v);
                setQ("");
                setSel(0);
            } else if (e.key === "Escape") setOpen(false);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    useEffect(() => {
        if (open) inputRef.current?.focus();
    }, [open]);

    const actions = useMemo<Action[]>(
        () => [
            { id: "contract", label: "Go to contract", hint: "portfolio", run: () => onNavigate("contract") },
            { id: "testing", label: "Go to tests", hint: "specs + editor", run: () => onNavigate("testing") },
            { id: "quality", label: "Go to quality", hint: "doctor · impact · trace", run: () => onNavigate("quality") },
            { id: "acquire", label: "Acquire: crawl the app", hint: "discovery", run: () => { window.location.hash = "#/contract/acquisition"; } },
            { id: "verify", label: "Verify the contract now", hint: "re-observe all facts", run: () => verify.mutate({}) },
            { id: "explore", label: "Explore uncovered requirements", hint: "agent", run: () => explore.mutate() },
            { id: "materialize", label: "Materialize Playwright specs", hint: "disposable", run: () => materialize.mutate({}) },
        ],
        [onNavigate, verify, explore, materialize],
    );

    const filtered = actions.filter((a) => a.label.toLowerCase().includes(q.trim().toLowerCase()));
    if (!open) return null;

    const runSel = (i: number) => {
        const a = filtered[i];
        if (!a) return;
        a.run();
        setOpen(false);
    };

    return (
        <div className="cmdk-overlay" onClick={() => setOpen(false)}>
            <div
                className="cmdk"
                role="dialog"
                aria-label="Command palette"
                onClick={(e) => e.stopPropagation()}
            >
                <input
                    ref={inputRef}
                    className="cmdk-input"
                    placeholder="type a command…"
                    value={q}
                    onChange={(e) => {
                        setQ(e.target.value);
                        setSel(0);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "ArrowDown") setSel((s) => Math.min(s + 1, filtered.length - 1));
                        if (e.key === "ArrowUp") setSel((s) => Math.max(s - 1, 0));
                        if (e.key === "Enter") runSel(sel);
                    }}
                    aria-label="Command"
                />
                <ul className="cmdk-list">
                    {filtered.map((a, i) => (
                        <li key={a.id}>
                            <button
                                type="button"
                                className={`cmdk-item ${i === sel ? "is-sel" : ""}`}
                                onMouseEnter={() => setSel(i)}
                                onClick={() => runSel(i)}
                            >
                                <span className="cmdk-label">{a.label}</span>
                                {a.hint ? <span className="cmdk-hint">{a.hint}</span> : null}
                            </button>
                        </li>
                    ))}
                    {filtered.length === 0 ? <li className="cmdk-empty">no matching command</li> : null}
                </ul>
                <div className="cmdk-foot">↑↓ select · ↵ run · esc close</div>
            </div>
            <style>{`
                .cmdk-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 9995; display: flex; align-items: flex-start; justify-content: center; padding-top: 12vh; backdrop-filter: blur(2px); }
                .cmdk { width: 460px; max-width: calc(100vw - 2rem); background: var(--bg-elev); border: 1px solid var(--hair-strong); box-shadow: var(--shadow-pop, 0 12px 32px rgba(0,0,0,.35)); font-family: var(--mono); }
                .cmdk-input { width: 100%; background: var(--bg); border: 0; border-bottom: 1px solid var(--hair); color: var(--ink); font-family: var(--mono); font-size: 13px; padding: 0.75rem 0.875rem; outline: none; }
                .cmdk-list { list-style: none; margin: 0; padding: 4px; max-height: 300px; overflow-y: auto; }
                .cmdk-item { display: flex; justify-content: space-between; align-items: baseline; width: 100%; background: transparent; border: 0; border-left: 2px solid transparent; color: var(--ink-dim); font-family: var(--mono); font-size: 12px; padding: 0.4375rem 0.625rem; cursor: pointer; text-align: left; transition: background var(--speed,120ms) var(--ease,ease), color var(--speed,120ms) var(--ease,ease); }
                .cmdk-item.is-sel { background: var(--bg-hover); color: var(--ink); border-left-color: var(--accent); }
                .cmdk-hint { color: var(--ink-faint); font-size: 10.5px; }
                .cmdk-empty { color: var(--ink-faint); font-size: 11.5px; padding: 0.625rem; }
                .cmdk-foot { border-top: 1px solid var(--hair); color: var(--ink-faint); font-size: 10px; padding: 0.375rem 0.75rem; }
            `}</style>
        </div>
    );
}
