/**
 * Git hook install / uninstall / inspection.
 *
 * Pure functions — every entry point takes an explicit `projectPath`. This is
 * what the CLI's `raiken hooks ...` commands call into, and what the dashboard
 * exposes via tRPC mutations.
 *
 * We deliberately do not depend on husky. If `.husky/` exists we write into
 * it; otherwise we fall back to `.git/hooks/` (resolved through git so
 * worktrees and `core.hooksPath` overrides work).
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type HookType = "pre-commit" | "pre-push";
export type HookKind = "husky" | "git";

export interface HookInstallOptions {
    projectPath: string;
    type?: HookType;
    /** Override the auto-detected default for `--skip-run`. */
    skipRun?: boolean;
    /** Force `.husky/` even when it doesn't exist yet. */
    husky?: boolean;
}

export interface HookInstallResult {
    type: HookType;
    kind: HookKind;
    /** Absolute path to the hook file we wrote. */
    hookPath: string;
    /** `hookPath` relative to `projectPath`. */
    relativePath: string;
    skipRun: boolean;
    description: string;
}

export interface HookUninstallOptions {
    projectPath: string;
    type?: HookType;
}

export interface HookUninstallResult {
    type: HookType;
    /** Files we touched (either stripped or deleted). */
    affected: Array<{ kind: HookKind; relativePath: string; action: "stripped" | "deleted" }>;
}

export interface HookStatusEntry {
    kind: HookKind;
    type: HookType;
    relativePath: string;
    /** True iff the file contains the raiken-managed marker block. */
    managed: boolean;
}

const HOOK_MARKER_BEGIN = "# >>> raiken hook (managed) >>>";
const HOOK_MARKER_END = "# <<< raiken hook (managed) <<<";
const SHEBANG = "#!/usr/bin/env sh";

const HOOK_DEFAULTS: Record<HookType, { skipRunDefault: boolean; description: string }> = {
    "pre-commit": {
        skipRunDefault: true,
        description: "Runs `raiken ci --staged --skip-run` to flag impact before commit.",
    },
    "pre-push": {
        skipRunDefault: false,
        description: "Runs `raiken ci` against the upstream base before push.",
    },
};

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

export function installHook(options: HookInstallOptions): HookInstallResult {
    const { projectPath } = options;
    const type = parseHookType(options.type);
    const skipRun = options.skipRun ?? HOOK_DEFAULTS[type].skipRunDefault;

    const target = chooseHookTarget(projectPath, options.husky === true);
    const hookPath = path.join(target.dir, type);

    const body = renderHookBody(type, { skipRun });
    const merged = mergeHook(safeRead(hookPath), body);

    fs.mkdirSync(target.dir, { recursive: true });
    fs.writeFileSync(hookPath, merged, "utf-8");
    try {
        fs.chmodSync(hookPath, 0o755);
    } catch {
        // Windows / restricted FS — chmod is best-effort.
    }

    return {
        type,
        kind: target.kind,
        hookPath,
        relativePath: path.relative(projectPath, hookPath),
        skipRun,
        description: HOOK_DEFAULTS[type].description,
    };
}

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

export function uninstallHook(options: HookUninstallOptions): HookUninstallResult {
    const { projectPath } = options;
    const type = parseHookType(options.type);

    const candidates = [
        { kind: "husky" as const, hookPath: path.join(projectPath, ".husky", type) },
        { kind: "git" as const, hookPath: path.join(projectPath, ".git", "hooks", type) },
    ];

    const affected: HookUninstallResult["affected"] = [];
    for (const { kind, hookPath } of candidates) {
        const existing = safeRead(hookPath);
        if (!existing) continue;
        const stripped = stripHookBlock(existing);
        if (stripped === null) continue;
        if (stripped.trim() === SHEBANG || stripped.trim().length === 0) {
            fs.unlinkSync(hookPath);
            affected.push({
                kind,
                relativePath: path.relative(projectPath, hookPath),
                action: "deleted",
            });
        } else {
            fs.writeFileSync(hookPath, stripped, "utf-8");
            affected.push({
                kind,
                relativePath: path.relative(projectPath, hookPath),
                action: "stripped",
            });
        }
    }

    return { type, affected };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export function getHookStatus(projectPath: string): HookStatusEntry[] {
    const entries: HookStatusEntry[] = [];

    for (const type of ["pre-commit", "pre-push"] as HookType[]) {
        const dirs: Array<[HookKind, string]> = [
            ["husky", path.join(projectPath, ".husky")],
            ["git", path.join(projectPath, ".git", "hooks")],
        ];
        for (const [kind, dir] of dirs) {
            const hookPath = path.join(dir, type);
            const existing = safeRead(hookPath);
            if (!existing) continue;
            entries.push({
                kind,
                type,
                relativePath: path.relative(projectPath, hookPath),
                managed: existing.includes(HOOK_MARKER_BEGIN),
            });
        }
    }

    return entries;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseHookType(value: HookType | string | undefined): HookType {
    const v = (value ?? "pre-commit").toLowerCase();
    if (v === "pre-commit" || v === "pre-push") return v;
    throw new Error(`Unknown hook type "${value}". Use pre-commit or pre-push.`);
}

function chooseHookTarget(
    projectPath: string,
    forceHusky: boolean,
): { dir: string; kind: HookKind } {
    const huskyDir = path.join(projectPath, ".husky");
    if (forceHusky || fs.existsSync(huskyDir)) {
        return { dir: huskyDir, kind: "husky" };
    }

    let hooksDir = path.join(projectPath, ".git", "hooks");
    try {
        const out = execSync("git rev-parse --git-path hooks", {
            cwd: projectPath,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        if (out) hooksDir = path.resolve(projectPath, out);
    } catch {
        // Not a git repo or git missing; fall back to the conventional path.
    }
    return { dir: hooksDir, kind: "git" };
}

function renderHookBody(type: HookType, opts: { skipRun: boolean }): string {
    const skipRunFlag = opts.skipRun ? " --skip-run" : "";
    const preamble = [
        "# Locate raiken; fail-soft if it isn't installed so the hook doesn't",
        "# block teammates who haven't run `npm i` yet.",
        'RAIKEN_BIN="$(command -v raiken 2>/dev/null || true)"',
        'if [ -z "$RAIKEN_BIN" ] && command -v npx >/dev/null 2>&1; then',
        "  if npx --no-install raiken --version >/dev/null 2>&1; then",
        '    RAIKEN_BIN="npx --no-install raiken"',
        "  fi",
        "fi",
        'if [ -z "$RAIKEN_BIN" ]; then',
        '  echo "[raiken] Skipped: CLI not installed. Run \\`npm i -D raiken\\` or \\`npx raiken\\`." >&2',
        "  exit 0",
        "fi",
    ];

    if (type === "pre-commit") {
        return [
            ...preamble,
            "",
            "# Skip on rebase/cherry-pick to avoid false noise.",
            'if [ -d "$(git rev-parse --git-dir)/rebase-merge" ] || [ -d "$(git rev-parse --git-dir)/rebase-apply" ]; then',
            "  exit 0",
            "fi",
            "",
            "# Run raiken impact analysis on the staged snapshot.",
            "# Exit code 1 = test failures; 2 = infra error. We forward both.",
            `$RAIKEN_BIN ci --staged${skipRunFlag} --format json --output-dir .raiken/ci/staged`,
        ].join("\n");
    }
    return [
        ...preamble,
        "",
        "# Run raiken impact analysis vs the upstream branch before push.",
        "# Falls back to the configured default base if no upstream is set.",
        "if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then",
        "  base=\"$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}')\"",
        `  $RAIKEN_BIN ci --base "$base"${skipRunFlag} --format json --output-dir .raiken/ci/push`,
        "else",
        `  $RAIKEN_BIN ci${skipRunFlag} --format json --output-dir .raiken/ci/push`,
        "fi",
    ].join("\n");
}

function mergeHook(existing: string | null, block: string): string {
    const wrapped = [HOOK_MARKER_BEGIN, block, HOOK_MARKER_END, ""].join("\n");

    if (!existing || existing.trim().length === 0) {
        return [SHEBANG, "", wrapped].join("\n");
    }
    if (existing.includes(HOOK_MARKER_BEGIN)) {
        return existing.replace(
            new RegExp(
                `${escapeRegex(HOOK_MARKER_BEGIN)}[\\s\\S]*?${escapeRegex(HOOK_MARKER_END)}\\n?`,
            ),
            `${wrapped}`,
        );
    }
    const sep = existing.endsWith("\n") ? "" : "\n";
    return `${existing}${sep}\n${wrapped}`;
}

function stripHookBlock(existing: string): string | null {
    if (!existing.includes(HOOK_MARKER_BEGIN)) return null;
    return existing.replace(
        new RegExp(
            `\\n?${escapeRegex(HOOK_MARKER_BEGIN)}[\\s\\S]*?${escapeRegex(HOOK_MARKER_END)}\\n?`,
        ),
        "\n",
    );
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeRead(p: string): string | null {
    try {
        return fs.readFileSync(p, "utf-8");
    } catch {
        return null;
    }
}
