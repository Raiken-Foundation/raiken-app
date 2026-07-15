/**
 * Claude Code-style "thinking" indicator: a spinner with a rotating verb and
 * a live elapsed-time readout, e.g. `Pondering… (12s · ctrl+c to stop)`.
 * Covers the silent gap between submitting a turn and the first token/tool
 * call so the prompt never looks frozen.
 */
import ora, { type Ora } from "ora";
import { dim } from "../agent-stream";

const VERBS = [
    "Thinking",
    "Reasoning",
    "Puzzling",
    "Mulling it over",
    "Working",
    "Considering",
    "Noodling",
];

export interface ThinkingHandle {
    stop(): void;
}

export function startThinking(): ThinkingHandle {
    const verb = VERBS[Math.floor(Math.random() * VERBS.length)];
    const startedAt = Date.now();
    const spinner: Ora = ora({ color: "magenta" }).start();

    const tick = (): void => {
        const secs = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
        spinner.text = dim(`${verb}… (${secs}s · ctrl+c to stop)`);
    };
    tick();
    const interval = setInterval(tick, 1000);

    return {
        stop(): void {
            clearInterval(interval);
            spinner.stop();
        },
    };
}
