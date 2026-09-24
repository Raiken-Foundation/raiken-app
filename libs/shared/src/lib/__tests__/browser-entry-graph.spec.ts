import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../../");
const SHARED_SRC = path.join(REPO_ROOT, "libs/shared/src");
const FORBIDDEN_RUNTIME_PREFIXES = ["@raiken/core", "crawlee", "@crawlee/"];

type ParsedImport = {
    specifiers: string[];
    typeOnly: boolean;
};

function resolveSharedModule(relativePath: string): string | null {
    const asFile = path.resolve(
        SHARED_SRC,
        relativePath.endsWith(".ts") ? relativePath : `${relativePath}.ts`,
    );
    if (fs.existsSync(asFile)) return asFile;
    const asDir = path.resolve(SHARED_SRC, relativePath, "index.ts");
    if (fs.existsSync(asDir)) return asDir;
    return null;
}

function parseImportStatements(source: string): ParsedImport[] {
    const imports: ParsedImport[] = [];
    const importRegex = /import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
    for (const match of source.matchAll(importRegex)) {
        const typeOnly = Boolean(match[1]);
        const clause = match[2]?.trim() ?? "";
        const from = match[3];
        if (!from) continue;
        if (typeOnly || clause.startsWith("type ")) {
            imports.push({ specifiers: [from], typeOnly: true });
            continue;
        }
        imports.push({ specifiers: [from], typeOnly: false });
    }

    const requireRegex = /require\(["']([^"']+)["']\)/g;
    for (const match of source.matchAll(requireRegex)) {
        const from = match[1];
        if (from) imports.push({ specifiers: [from], typeOnly: false });
    }

    const exportFromRegex = /export\s+(type\s+)?[\s\S]*?\sfrom\s+["']([^"']+)["']/g;
    for (const match of source.matchAll(exportFromRegex)) {
        const typeOnly = Boolean(match[1]);
        const from = match[2];
        if (!from) continue;
        imports.push({ specifiers: [from], typeOnly });
    }

    return imports;
}

function collectRuntimeExternalImports(entryRelativePath: string): string[] {
    const visited = new Set<string>();
    const externals = new Set<string>();

    function visit(relativePath: string): void {
        const absolutePath = resolveSharedModule(relativePath);
        if (!absolutePath || visited.has(absolutePath)) return;
        visited.add(absolutePath);

        const source = fs.readFileSync(absolutePath, "utf-8");
        for (const entry of parseImportStatements(source)) {
            if (entry.typeOnly) continue;
            for (const specifier of entry.specifiers) {
                if (specifier.startsWith(".")) {
                    const nextRelative = path
                        .relative(SHARED_SRC, path.resolve(path.dirname(absolutePath), specifier))
                        .replace(/\\/g, "/");
                    visit(nextRelative);
                    continue;
                }
                externals.add(specifier);
            }
        }
    }

    visit(entryRelativePath);
    return [...externals].sort();
}

describe("@raiken/shared browser entry import graph", () => {
    it("does not reach @raiken/core or Crawlee through runtime imports", () => {
        const runtimeImports = collectRuntimeExternalImports("index.ts");
        const forbidden = runtimeImports.filter((specifier) =>
            FORBIDDEN_RUNTIME_PREFIXES.some((prefix) => specifier.startsWith(prefix)),
        );
        expect(forbidden).toEqual([]);
    });

    it("keeps browser leaf modules free of core runtime", () => {
        for (const leaf of [
            "lib/config-patch.ts",
            "lib/config-defaults.ts",
            "lib/config-public.ts",
            "lib/hitl-workflow.ts",
            "lib/errors/client.ts",
            "lib/errors/types.ts",
            "lib/health-types.ts",
        ]) {
            const runtimeImports = collectRuntimeExternalImports(leaf);
            const forbidden = runtimeImports.filter((specifier) =>
                FORBIDDEN_RUNTIME_PREFIXES.some((prefix) => specifier.startsWith(prefix)),
            );
            expect(forbidden, leaf).toEqual([]);
        }
    });

    it("does not pull the server tRPC adapter through the browser errors barrel", () => {
        const runtimeImports = collectRuntimeExternalImports("lib/errors/index.ts");
        expect(runtimeImports).not.toContain("@raiken/core");
        expect(runtimeImports).not.toContain("./trpc-adapter");
    });
});
