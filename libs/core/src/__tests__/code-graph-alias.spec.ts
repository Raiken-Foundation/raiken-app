import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodeGraph } from "../analysis/code-graph";

/**
 * Pins the bundler-alias contract end to end (review finding,
 * code-graph.ts:164-233): a vite.config alias like `'@': './src'` must let
 * the graph resolve `import … from '@/widget'` to the real file. The old
 * extraction ran its regexes on string-blanked content, so it could never
 * match and every aliased import went unresolved.
 */

let projectPath: string;

beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-alias-"));
});

afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true });
});

describe("code-graph path aliases", () => {
    it("resolves vite alias config to real dependency edges", async () => {
        fs.writeFileSync(
            path.join(projectPath, "vite.config.ts"),
            [
                "import { defineConfig } from 'vite';",
                "export default defineConfig({",
                "  resolve: {",
                "    alias: { '@': './src' },",
                "  },",
                "});",
                "",
            ].join("\n"),
        );
        fs.mkdirSync(path.join(projectPath, "src"), { recursive: true });
        fs.writeFileSync(
            path.join(projectPath, "src", "widget.ts"),
            "export const widget = 1;\n",
        );
        fs.writeFileSync(
            path.join(projectPath, "src", "app.ts"),
            "import { widget } from '@/widget';\nexport const app = widget;\n",
        );

        const graph = new CodeGraph(projectPath, { includeTests: false });
        await graph.scanProject();

        const appNode = graph
            .getAllFiles()
            .find((node) => node.relativePath.endsWith("app.ts"));
        expect(appNode).toBeDefined();
        const widgetEdge = appNode?.imports.some((imported) =>
            imported.endsWith(path.join("src", "widget.ts")),
        );
        expect(widgetEdge).toBe(true);
    });
});
