import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "../utils/trpc";

interface Action {
    id: string;
    label: string;
    hint?: string;
    run: () => void;
}

/**
 * Cmd+K action hub (Linear pattern): navigation + contract operations.
 *
 * Dialog accessibility: focus is trapped inside the dialog while open and
 * restored to the invoker on close; the highlighted option is announced via
 * aria-activedescendant so screen readers follow the arrow-key selection.
 */
export function CommandPalette({
    onNavigate,
}: {
    onNavigate: (view: "board" | "contract" | "testing" | "quality") => void;
}) {
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState("");
    const [sel, setSel] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const restoreFocusRef = useRef<HTMLElement | null>(null);
    const utils = trpc.useUtils();
    const verify = trpc.contractVerify.useMutation({
        onSettled: () => void utils.contractView.invalidate(),
    });
    const materialize = trpc.contractMaterialize.useMutation();
    const explore = trpc.contractExplore.useMutation({
        onSettled: () => void utils.contractView.invalidate(),
    });

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
                e.preventDefault();
                setOpen((v) => {
                    if (!v) restoreFocusRef.current = document.activeElement as HTMLElement | null;
                    return !v;
                });
                setQ("");
                setSel(0);
            } else if (e.key === "Escape") setOpen(false);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    useEffect(() => {
        if (open) inputRef.current?.focus();
        else {
            // Returning focus to the invoker — a closed dialog must not
            // strand keyboard users at the top of the document.
            restoreFocusRef.current?.focus();
            restoreFocusRef.current = null;
        }
    }, [open]);

    // Focus trap: Tab (and Shift+Tab) cycle within the dialog.
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Tab") return;
            const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
                "input, button, [href], [tabindex]:not([tabindex='-1'])",
            );
            if (!focusables || focusables.length === 0) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open]);

    const actions = useMemo<Action[]>(
        () => [
            {
                id: "board",
                label: "Go to status board",
                hint: "the front door",
                run: () => onNavigate("board"),
            },
            {
                id: "contract",
                label: "Go to contract",
                hint: "portfolio",
                run: () => onNavigate("contract"),
            },
            {
                id: "testing",
                label: "Go to tests",
                hint: "specs + editor",
                run: () => onNavigate("testing"),
            },
            {
                id: "quality",
                label: "Go to quality",
                hint: "doctor · impact · trace",
                run: () => onNavigate("quality"),
            },
            {
                id: "acquire",
                label: "Acquire: crawl the app",
                hint: "discovery",
                run: () => {
                    window.location.hash = "#/contract/acquisition";
                },
            },
            {
                id: "verify",
                label: "Verify the contract now",
                hint: "re-observe all facts",
                run: () => verify.mutate({}),
            },
            {
                id: "explore",
                label: "Explore uncovered requirements",
                hint: "agent",
                run: () => explore.mutate(),
            },
            {
                id: "materialize",
                label: "Materialize Playwright specs",
                hint: "disposable",
                run: () => materialize.mutate({}),
            },
        ],
        [onNavigate, verify, explore, materialize],
    );

    const filtered = actions.filter((a) => a.label.toLowerCase().includes(q.trim().toLowerCase()));
    if (!open) return null;

    const listId = "cmdk-list";
    const optionId = (i: number) => `cmdk-option-${i}`;

    const runSel = (i: number) => {
        const a = filtered[i];
        if (!a) return;
        a.run();
        setOpen(false);
    };

    return (
        <div className="cmdk-overlay" onClick={() => setOpen(false)}>
            <div
                ref={dialogRef}
                className="cmdk"
                role="dialog"
                aria-modal="true"
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
                        if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setSel((s) => Math.min(s + 1, filtered.length - 1));
                        }
                        if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setSel((s) => Math.max(s - 1, 0));
                        }
                        if (e.key === "Enter") runSel(sel);
                    }}
                    role="combobox"
                    aria-expanded="true"
                    aria-controls={listId}
                    aria-activedescendant={filtered.length > 0 ? optionId(sel) : undefined}
                    aria-label="Command"
                    aria-autocomplete="list"
                />
                <ul className="cmdk-list" id={listId} role="listbox" aria-label="Commands">
                    {filtered.map((a, i) => (
                        <li key={a.id} role="presentation">
                            <button
                                type="button"
                                id={optionId(i)}
                                role="option"
                                aria-selected={i === sel}
                                className={`cmdk-item ${i === sel ? "is-sel" : ""}`}
                                onMouseEnter={() => setSel(i)}
                                onClick={() => runSel(i)}
                                tabIndex={-1}
                            >
                                <span className="cmdk-label">{a.label}</span>
                                {a.hint ? <span className="cmdk-hint">{a.hint}</span> : null}
                            </button>
                        </li>
                    ))}
                    {filtered.length === 0 ? (
                        <li className="cmdk-empty">no matching command</li>
                    ) : null}
                </ul>
                <div className="cmdk-foot">↑↓ select · ↵ run · esc close</div>
            </div>
            <style>{`
                .cmdk-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 9995; display: flex; align-items: flex-start; justify-content: center; padding-top: 12vh; backdrop-filter: blur(2px); }
                .cmdk { width: 460px; max-width: calc(100vw - 2rem); background: var(--bg-elev); border: 1px solid var(--hair-strong); box-shadow: var(--shadow-pop, 0 12px 32px rgba(0,0,0,.35)); font-family: var(--mono); }
                .cmdk-input { width: 100%; background: var(--bg); border: 0; border-bottom: 1px solid var(--hair); color: var(--ink); font-family: var(--mono); font-size: 13px; padding: 0.75rem 0.875rem; }
                .cmdk-input:focus-visible, .cmdk-input:focus { outline: none; box-shadow: inset 0 -2px 0 var(--accent); }
                .cmdk-list { list-style: none; margin: 0; padding: 4px; max-height: 300px; overflow-y: auto; }
                .cmdk-item { display: flex; justify-content: space-between; align-items: baseline; width: 100%; background: transparent; border: 0; border-left: 2px solid transparent; color: var(--ink-dim); font-family: var(--mono); font-size: 12px; padding: 0.4375rem 0.625rem; cursor: pointer; text-align: left; transition: background var(--speed,120ms) var(--ease,ease), color var(--speed,120ms) var(--ease,ease); }
                .cmdk-item.is-sel, .cmdk-item[aria-selected="true"] { background: var(--bg-hover); color: var(--ink); border-left-color: var(--accent); }
                .cmdk-hint { color: var(--ink-faint); font-size: 10.5px; }
                .cmdk-empty { color: var(--ink-faint); font-size: 11.5px; padding: 0.625rem; }
                .cmdk-foot { border-top: 1px solid var(--hair); color: var(--ink-faint); font-size: 10px; padding: 0.375rem 0.75rem; }
            `}</style>
        </div>
    );
}
