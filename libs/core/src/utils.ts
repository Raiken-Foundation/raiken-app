import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";

export function getParamName(param: t.Node): string {
    if (t.isIdentifier(param)) {
        return param.name;
    } else if (t.isRestElement(param) && t.isIdentifier(param.argument)) {
        return `...${param.argument.name}`;
    } else if (t.isAssignmentPattern(param)) {
        // Default-valued params (`function f(a = 1)`): record the bound
        // name, not the literal "param" — default params are ubiquitous and
        // corrupted every affected signature downstream (review finding).
        return getParamName(param.left);
    } else if (t.isTSParameterProperty(param)) {
        // Constructor parameter properties (`constructor(private x: T)`).
        return getParamName(param.parameter);
    } else if (t.isObjectPattern(param)) {
        return "{ ... }";
    } else if (t.isArrayPattern(param)) {
        return "[ ... ]";
    }
    return "param";
}

export function isExportedNode(path: NodePath<t.Node> | null | undefined): boolean {
    let current = path;
    while (current) {
        if (
            t.isExportNamedDeclaration(current.node) ||
            t.isExportDefaultDeclaration(current.node)
        ) {
            return true;
        }
        current = current.parentPath;
    }
    return false;
}

export async function countLines(filePath: string): Promise<number> {
    try {
        const content = await fs.readFile(filePath, "utf-8");
        return content.split("\n").length;
    } catch {
        return 0;
    }
}

export function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 Bytes";

    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${Math.round((bytes / k ** i) * 100) / 100} ${sizes[i]}`;
}

/**
 * Normalize LLM-produced test code into what should actually land on disk.
 *
 * Models often wrap output in a Markdown code fence (```ts … ```) and add
 * trailing whitespace. Every save path must run this so the on-disk file is
 * identical regardless of which surface saved it (chat auto-save, HITL
 * approval, the agent's saveFile tool, or run-on-buffer). Without a single
 * shared cleaner the same generated test could be written three slightly
 * different ways, which is exactly the "formatting differs after save" bug.
 */
export function cleanGeneratedTestCode(raw: string): string {
    let content = raw;

    // Collect ALL fenced blocks, not just the first. Models sometimes precede
    // the real test with a small illustrative snippet (or wrap prose in fences),
    // and taking `[0]` would then truncate to the wrong block. Prefer the block
    // that looks most like a test file (has import/test/expect), breaking ties
    // by length; fall back to the first block, then to the dangling-fence path.
    const fenceRe = /```(?:typescript|ts|javascript|js|tsx|jsx)?\s*\n([\s\S]*?)```/gi;
    const blocks: string[] = [];
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard global-regex exec loop
    while ((m = fenceRe.exec(content)) !== null) {
        blocks.push(m[1]);
    }

    if (blocks.length > 0) {
        const isTestish = (b: string) => /\b(import|test|expect|describe|test\.describe)\b/.test(b);
        const candidates = blocks.filter(isTestish);
        const pool = candidates.length > 0 ? candidates : blocks;
        content = pool.reduce((best, b) => (b.length > best.length ? b : best), pool[0]);
    } else {
        // No matched pair — strip a dangling opening fence and any closing fence.
        content = content.replace(/^```(?:typescript|ts|javascript|js|tsx|jsx)?\s*\n?/i, "");
        const closingIdx = content.lastIndexOf("\n```");
        if (closingIdx !== -1) {
            content = content.substring(0, closingIdx);
        }
    }

    content = hardenNavigationWaits(content);

    // Normalize line endings and strip trailing whitespace per line so the
    // saved file matches what a formatter-clean editor would show.
    return `${content
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+$/gm, "")
        .trim()}\n`;
}

/**
 * Make generated navigation resilient on real-world apps.
 *
 * Two Playwright defaults sink tests against production-like SPAs:
 *  - `page.goto(url)` waits for the `load` event, which never fires within the
 *    timeout on apps that hold a resource open (analytics beacons, hanging
 *    images, streamed responses).
 *  - `waitForLoadState('networkidle')` never settles when the app keeps a
 *    persistent connection open (websockets/Pusher, SSE, polling). Playwright
 *    itself discourages `networkidle`.
 *
 * We rewrite both to `domcontentloaded`, which resolves as soon as the DOM is
 * ready — tests then wait on concrete elements (already how the model asserts).
 * Conservative by construction: only string-literal single-arg `goto()` calls
 * gain options, and only explicit `networkidle` waits are downgraded.
 */
export function hardenNavigationWaits(code: string): string {
    let out = code;

    // 1. Add `{ waitUntil: "domcontentloaded" }` to bare string-literal gotos.
    out = out.replace(
        /\.goto\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*\)/g,
        (_full, q: string, url: string) =>
            `.goto(${q}${url}${q}, { waitUntil: "domcontentloaded" })`,
    );

    // 2. Downgrade explicit networkidle waits (both call styles).
    out = out.replace(
        /waitForLoadState\(\s*(['"`])networkidle\1\s*\)/g,
        'waitForLoadState("domcontentloaded")',
    );
    out = out.replace(/waitUntil:\s*(['"`])networkidle\1/g, 'waitUntil: "domcontentloaded"');

    return out;
}

export function isTestDirectory(dirName: string): boolean {
    const testDirs = ["__tests__", "__test__", "test", "tests", "spec", "specs", "e2e", "cypress"];
    return testDirs.includes(dirName.toLowerCase());
}

export function isTestFile(fileName: string): boolean {
    return fileName.includes(".test.") || fileName.includes(".spec.") || fileName.includes(".e2e.");
}

/**
 * Detect binary files by sampling a small buffer.
 * Treats null bytes or high non-text ratio as binary.
 */
export async function isBinaryFile(filePath: string, sampleSize = 8000): Promise<boolean> {
    try {
        const handle = await fs.open(filePath, "r");
        try {
            const buffer = Buffer.alloc(sampleSize);
            const { bytesRead } = await handle.read(buffer, 0, sampleSize, 0);
            if (bytesRead === 0) return false;

            let nonText = 0;
            for (let i = 0; i < bytesRead; i++) {
                const byte = buffer[i];
                if (byte === 0) return true;
                if (byte < 7 || (byte > 14 && byte < 32) || byte === 127) {
                    nonText++;
                }
            }

            return nonText / bytesRead > 0.3;
        } finally {
            await handle.close();
        }
    } catch (error) {
        // An I/O error (permission denied, file vanished mid-read, etc) tells
        // us nothing about whether the file is text — treating it as text
        // would send unreadable bytes into a "utf-8" read and a parser next.
        // Skip it like a binary file instead, and say why.
        console.warn(
            `[isBinaryFile] Could not inspect "${filePath}" — treating as unreadable/binary: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        return true;
    }
}

/**
 * Recursively scan a directory for files matching a pattern
 */
export async function scanDirectoryForPattern(
    dirPath: string,
    pattern: string,
    relativeTo: string,
): Promise<string[]> {
    const matches: string[] = [];

    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);

            if (entry.isDirectory()) {
                // Recursively scan subdirectories
                const subDirMatches = await scanDirectoryForPattern(
                    fullPath,
                    pattern,
                    path.join(relativeTo, entry.name),
                );
                matches.push(...subDirMatches);
            } else if (entry.isFile()) {
                const relativePath = path.join(relativeTo, entry.name);
                // Check if this file matches the pattern
                if (relativePath.toLowerCase().includes(pattern)) {
                    matches.push(relativePath);
                }
            }
        }
    } catch (error) {
        console.warn(`Could not scan directory ${dirPath}:`, error);
    }

    return matches;
}

/**
 * Extract URL from a user message
 * Supports both full URLs (http://...) and shorthand (localhost:3000)
 * Handles markdown formatting (strips ** and ` characters)
 */
export function extractURLFromMessage(message: string): string | null {
    // Strip markdown formatting that might wrap URLs
    const cleanedMessage = message
        .replace(/\*\*/g, "") // Remove bold markers
        .replace(/\*/g, "") // Remove italic markers
        .replace(/`/g, "") // Remove backticks
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); // Extract text from markdown links

    // First try full URL with protocol
    // Exclude common markdown/punctuation chars at the end
    const fullUrlRegex = /https?:\/\/[^\s)>\]"']+/gi;
    const fullMatch = cleanedMessage.match(fullUrlRegex);
    if (fullMatch) {
        // Clean any trailing punctuation
        return fullMatch[0].replace(/[.,;:!?]+$/, "");
    }

    // Try localhost with port (e.g., "localhost:3000")
    const localhostRegex = /\blocalhost:\d+\b/gi;
    const localhostMatch = cleanedMessage.match(localhostRegex);
    if (localhostMatch) {
        return `http://${localhostMatch[0]}`;
    }

    // Try IP with port (e.g., "127.0.0.1:3000")
    const ipRegex = /\b(?:\d{1,3}\.){3}\d{1,3}:\d+\b/gi;
    const ipMatch = cleanedMessage.match(ipRegex);
    if (ipMatch) {
        return `http://${ipMatch[0]}`;
    }

    return null;
}
