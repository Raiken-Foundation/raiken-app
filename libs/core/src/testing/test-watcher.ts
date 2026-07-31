/**
 * Filesystem watcher backing `raiken test --watch`.
 *
 * Lives in core (which owns the chokidar dependency) so the CLI stays a thin
 * loop: the watcher emits debounced change triggers, the caller cancels any
 * in-flight run and starts a fresh one. Watches the whole project minus the
 * noisy/derived directories — app-code edits should re-run the suite too,
 * not just spec edits.
 */

import { type FSWatcher, watch } from "chokidar";

export interface TestWatchTrigger {
    /** Which change fired this trigger (project-relative, posix slashes). */
    file: string;
    event: "add" | "change" | "unlink";
}

export interface TestWatcherOptions {
    projectPath: string;
    /** Extra directory names to ignore on top of the defaults. */
    ignoreDirs?: string[];
    /** Quiet period before a burst of saves becomes one trigger. Default 350ms. */
    debounceMs?: number;
    onTrigger: (trigger: TestWatchTrigger) => void;
    onReady?: (watchedDir: string) => void;
    onError?: (error: unknown) => void;
}

export interface TestWatcherHandle {
    close(): Promise<void>;
}

const DEFAULT_IGNORED_DIRS = new Set([
    "node_modules",
    ".git",
    ".raiken",
    "test-results",
    "test-reports",
    "playwright-report",
    "dist",
    "build",
    "out",
    "coverage",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
]);

export function startTestWatcher(options: TestWatcherOptions): TestWatcherHandle {
    const ignored = new Set([...DEFAULT_IGNORED_DIRS, ...(options.ignoreDirs ?? [])]);
    const debounceMs = options.debounceMs ?? 350;

    const watcher: FSWatcher = watch(options.projectPath, {
        ignoreInitial: true,
        depth: 12,
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
        ignored: (watchedPath, stats) => {
            if (watchedPath === options.projectPath) return false;
            if (stats?.isFile()) return false;
            const segments = watchedPath.split(/[\\/]/);
            return segments.some((segment) => ignored.has(segment));
        },
    });

    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: TestWatchTrigger | null = null;

    const schedule = (trigger: TestWatchTrigger) => {
        pending = trigger;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            const fire = pending;
            timer = null;
            pending = null;
            if (fire) options.onTrigger(fire);
        }, debounceMs);
        timer.unref?.();
    };

    watcher.on("add", (file) => schedule({ file, event: "add" }));
    watcher.on("change", (file) => schedule({ file, event: "change" }));
    watcher.on("unlink", (file) => schedule({ file, event: "unlink" }));
    watcher.on("ready", () => options.onReady?.(options.projectPath));
    watcher.on("error", (error) => options.onError?.(error));

    return {
        close: async () => {
            if (timer) clearTimeout(timer);
            timer = null;
            pending = null;
            await watcher.close();
        },
    };
}
