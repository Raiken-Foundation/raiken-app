import * as path from "node:path";
import type { ParsedFile } from "../types";
import { parseSourceFile } from "./ast-parser";
import { extractTemplateSelectors, isMarkupFile } from "./markup-selectors";
import { sfcFlavor, sfcScriptFilename, splitSfc } from "./sfc";

/**
 * One entry point for "read what you can out of this file".
 *
 * Indexing used to be a single branch: Babel, or nothing. That left three kinds
 * of file silently empty — SFCs (Babel throws on `<template>`), and the templates
 * of any backend Raiken cannot parse at all. This routes each kind to the
 * analyzer that can actually read it, and degrades to the parts that worked
 * rather than discarding the file.
 */

/** Extensions handed to the JS/TS parser directly. */
export const SCRIPT_EXTENSIONS: readonly string[] = [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
];

export type SourceKind = "script" | "sfc" | "markup";

export interface SourceAnalysis {
    parsed: ParsedFile;
    /** Babel AST, when a script was present and parsed. */
    ast?: unknown;
    kind: SourceKind;
    /** Set when a script was present but unparseable; markup results still stand. */
    parseError?: string;
}

/** Fresh arrays per call — callers mutate the result while building a node. */
function emptyParsed(): ParsedFile {
    return { functions: [], classes: [], imports: [], exports: [], types: [] };
}

export function classifySourceFile(filePath: string): SourceKind | null {
    if (sfcFlavor(filePath)) return "sfc";
    if (SCRIPT_EXTENSIONS.includes(path.extname(filePath).toLowerCase())) return "script";
    if (isMarkupFile(filePath)) return "markup";
    return null;
}

/**
 * Analyze a file according to its kind. Returns `null` for kinds we do not read,
 * so callers can keep treating those as plain graph nodes.
 *
 * Throws only for a plain script that fails to parse, preserving the existing
 * contract for `.ts`/`.js`. An SFC whose script is broken still returns its
 * template selectors, since a half-readable component beats an empty one.
 */
export function analyzeSourceFile(
    code: string,
    filePath: string,
    options: {
        /**
         * Parse an unrecognized extension as a plain script. Set by callers with
         * a configured extension allowlist, so a project that indexes an unusual
         * JS extension keeps working.
         */
        unknownAsScript?: boolean;
    } = {},
): SourceAnalysis | null {
    const kind = classifySourceFile(filePath) ?? (options.unknownAsScript ? "script" : null);
    if (!kind) return null;

    if (kind === "script") {
        const result = parseSourceFile(code, filePath);
        return { parsed: result.parsed, ast: result.ast, kind };
    }

    if (kind === "markup") {
        const templateSelectors = extractTemplateSelectors(code);
        const parsed = emptyParsed();
        if (templateSelectors.length > 0) parsed.templateSelectors = templateSelectors;
        return { parsed, kind };
    }

    const split = splitSfc(code);
    const templateSelectors = extractTemplateSelectors(split.markup);

    let parsed = emptyParsed();
    let ast: unknown;
    let parseError: string | undefined;

    if (split.hasScript) {
        try {
            const result = parseSourceFile(
                split.script,
                sfcScriptFilename(filePath, split.language),
            );
            parsed = result.parsed;
            ast = result.ast;
        } catch (error) {
            parseError = error instanceof Error ? error.message : String(error);
        }
    }

    if (templateSelectors.length > 0) parsed.templateSelectors = templateSelectors;

    return { parsed, ast, kind, ...(parseError ? { parseError } : {}) };
}
