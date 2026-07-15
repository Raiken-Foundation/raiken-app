/**
 * Test-file inventory for `raiken organize` — cheap, regex-based (no AST) to
 * stay consistent with the rest of the doctor/report tooling, which
 * deliberately avoids a full TS parser for this kind of lightweight scan.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CodeGraphDB } from "../database/db";
import { toPosixPath } from "./path-utils";
import type { TestInventoryEntry } from "./types";

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

/** Scratch runs saved by the "run on buffer" flow — never a reorganize target. */
const SCRATCH_FILE_PATTERN = /\.raiken-run-\d+\.spec\.(ts|tsx|js|jsx)$/;

const TITLE_PATTERN =
    /\b(?:test\s*\.\s*describe|describe|test|it)\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;

export function buildTestInventory(
    projectPath: string,
    testDirectory: string,
): TestInventoryEntry[] {
    const absRoot = path.resolve(projectPath, testDirectory);
    if (!fs.existsSync(absRoot)) return [];

    const files = listTestDirectoryFiles(absRoot);

    // Keyed by the OS-native relative path — that's the convention every
    // other writer (router.ts, tools.ts) uses for `test_source_map` rows.
    let sourceFilesByTest = new Map<string, string[]>();
    try {
        const db = new CodeGraphDB(projectPath);
        try {
            for (const abs of files) {
                const rel = path.relative(projectPath, abs);
                const sources = db.getSourceFilesForTest(rel);
                if (sources.length > 0) sourceFilesByTest.set(rel, sources);
            }
        } finally {
            db.close();
        }
    } catch {
        // No DB yet (fresh project) — proceed without source-file hints.
        sourceFilesByTest = new Map();
    }

    return files.map((abs) => {
        const relativeNative = path.relative(projectPath, abs);
        let text = "";
        let sizeBytes = 0;
        try {
            const stat = fs.statSync(abs);
            sizeBytes = stat.size;
            text = fs.readFileSync(abs, "utf-8");
        } catch {
            // Unreadable file — still list it with empty metadata rather than
            // silently dropping it from the inventory.
        }

        return {
            // Forward-slash form from here on — this is what gets shown to
            // the AI and compared against its proposed moves.
            relativePath: toPosixPath(relativeNative),
            titles: extractTitles(text),
            sourceFiles: sourceFilesByTest.get(relativeNative) ?? [],
            sizeBytes,
        };
    });
}

function extractTitles(text: string): string[] {
    const titles: string[] = [];
    let match: RegExpExecArray | null;
    TITLE_PATTERN.lastIndex = 0;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard global-regex exec loop
    while ((match = TITLE_PATTERN.exec(text)) !== null) {
        titles.push(match[2]);
    }
    return titles;
}

/**
 * Every candidate test-suite file under `absRoot` (absolute paths). Shared
 * with `apply.ts`, which rescans the directory post-move to rewrite relative
 * imports that reference moved files.
 */
export function listTestDirectoryFiles(absRoot: string): string[] {
    const files: string[] = [];
    collectFiles(absRoot, files);
    return files;
}

function collectFiles(dir: string, out: string[]): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
            collectFiles(full, out);
        } else if (entry.isFile()) {
            if (SCRATCH_FILE_PATTERN.test(entry.name)) continue;
            if (DEFAULT_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(full);
        }
    }
}
