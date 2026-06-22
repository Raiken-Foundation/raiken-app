import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";

export function getParamName(param: t.Node): string {
    if (t.isIdentifier(param)) {
        return param.name;
    } else if (t.isRestElement(param) && t.isIdentifier(param.argument)) {
        return `...${param.argument.name}`;
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
    } catch {
        return false;
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
