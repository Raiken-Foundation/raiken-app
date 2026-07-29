import * as path from "node:path";
import { maskMatches, maskOutside, type SourceRegion } from "./masking";

/**
 * Single-file components split into the parts each analyzer can read.
 *
 * Babel cannot parse a `.vue` or `.svelte` file — the `<template>` block is not
 * JavaScript — which is why these extensions used to be indexed as empty nodes
 * with no symbols and no searchable text. Splitting first gives the JS/TS parser
 * something valid to read and the markup scanner somewhere to find selectors.
 */

export type SfcFlavor = "vue" | "svelte";

const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const STYLE_BLOCK = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi;
const TS_LANG = /\blang\s*=\s*["'](ts|typescript)["']/i;

export interface SfcSplit {
    /** Script bodies in their original positions, everything else blanked. */
    script: string;
    /** Markup with script and style blocks blanked. */
    markup: string;
    /** TypeScript when any block declares `lang="ts"`. */
    language: "ts" | "js";
    hasScript: boolean;
}

export function sfcFlavor(filePath: string): SfcFlavor | null {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".vue") return "vue";
    if (ext === ".svelte") return "svelte";
    return null;
}

/**
 * Split an SFC into a parseable script and scannable markup.
 *
 * Both halves keep the original line numbering, so a symbol reported at line 42
 * of the script really is at line 42 of the `.vue` file.
 */
export function splitSfc(code: string): SfcSplit {
    const scriptBodies: SourceRegion[] = [];
    let language: "ts" | "js" = "js";

    for (const match of code.matchAll(SCRIPT_BLOCK)) {
        const attrs = match[1] ?? "";
        const body = match[2] ?? "";
        const openTagLength = match[0].indexOf(">") + 1;
        const start = (match.index ?? 0) + openTagLength;

        scriptBodies.push({ start, end: start + body.length });
        if (TS_LANG.test(attrs)) language = "ts";
    }

    return {
        script: maskOutside(code, scriptBodies),
        markup: maskMatches(maskMatches(code, SCRIPT_BLOCK), STYLE_BLOCK),
        language,
        hasScript: scriptBodies.length > 0,
    };
}

/**
 * A filename to hand Babel for an SFC's script.
 *
 * The parser picks its plugins from the extension, so a `lang="ts"` block has to
 * arrive looking like TypeScript.
 */
export function sfcScriptFilename(filePath: string, language: "ts" | "js"): string {
    return `${filePath}.${language}`;
}
