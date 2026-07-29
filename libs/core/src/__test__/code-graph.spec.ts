/**
 * Reliability-focused coverage for CodeGraph: file deletion must always
 * notify listeners (this is how ProjectContext keeps the DB in sync with
 * the filesystem), oversized files must be skipped rather than OOMing the
 * indexer, and SFC-only extensions (.vue/.svelte) must not be handed to the
 * JS/TS parser where they'd always fail.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodeGraph } from "../analysis/code-graph";
import type { UpdateEvent } from "../types";

describe("CodeGraph reliability", () => {
    let projectPath: string;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-code-graph-"));
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    function writeFile(relPath: string, content: string) {
        const abs = path.join(projectPath, relPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
        return abs;
    }

    it("notifies onUpdate when removing a file that is in the graph", async () => {
        const filePath = writeFile("src/a.ts", "export const a = 1;\n");
        const events: UpdateEvent[] = [];
        const graph = new CodeGraph(projectPath, { onUpdate: (event) => events.push(event) });

        await graph.updateFile(filePath);
        events.length = 0; // Only care about the removal below.

        await graph.removeFile(filePath);

        expect(events).toHaveLength(1);
        expect(events[0]?.type).toBe("remove");
        expect(events[0]?.filePath).toBe(path.resolve(filePath));
        graph.destroy();
    });

    it("still notifies onUpdate when removing a path that was never indexed", async () => {
        // Regression guard: ProjectContext.handleWatchEvent is the only
        // thing that deletes the DB row for a deleted file. If removeFile()
        // doesn't fire onUpdate for a path outside of `this.nodes` too, a
        // stale row can survive forever for files that were never
        // successfully added to the in-memory graph (e.g. failed parse
        // then later deleted).
        const events: UpdateEvent[] = [];
        const graph = new CodeGraph(projectPath, { onUpdate: (event) => events.push(event) });

        const ghostPath = path.join(projectPath, "src/never-indexed.ts");
        await graph.removeFile(ghostPath);

        expect(events).toHaveLength(1);
        expect(events[0]?.type).toBe("remove");
        expect(events[0]?.affectedFiles).toEqual([]);
        graph.destroy();
    });

    it("skips files larger than maxFileSizeBytes instead of reading them into memory", async () => {
        const bigPath = writeFile("src/huge.ts", "x".repeat(1024));
        const smallPath = writeFile("src/small.ts", "export const small = 1;\n");
        const graph = new CodeGraph(projectPath, { maxFileSizeBytes: 100 });

        await graph.updateFile(bigPath);
        await graph.updateFile(smallPath);

        expect(graph.getNode(bigPath)).toBeUndefined();
        expect(graph.getNode(smallPath)).not.toBeUndefined();
        graph.destroy();
    });

    it("indexes an SFC by parsing its script block and scanning its template", async () => {
        const vuePath = writeFile(
            "src/App.vue",
            `<template><button data-testid="go">hi</button></template>
<script setup lang="ts">
function go(): void {}
</script>
`,
        );
        const graph = new CodeGraph(projectPath, {});

        await graph.updateFile(vuePath);

        const node = graph.getNode(vuePath);
        // Handing the raw SFC to Babel throws, which is why these files used to
        // be indexed empty. The script block is split out first now, so the
        // component contributes real symbols and its template contributes
        // selectors.
        expect(node?.ast).not.toBeUndefined();
        expect(node?.parsed.functions.map((f) => f.name)).toEqual(["go"]);
        expect(node?.parsed.templateSelectors?.map((s) => s.value)).toEqual(["go"]);
        graph.destroy();
    });

    it("indexes selectors from a template whose backend it cannot parse", async () => {
        const templatePath = writeFile(
            "templates/settings.html",
            `<h1>Settings</h1>
<button data-testid="delete-workspace">Delete</button>
<b data-testid="{{ dynamic }}">skip me</b>
`,
        );
        const graph = new CodeGraph(projectPath, {});

        await graph.updateFile(templatePath);

        const node = graph.getNode(templatePath);
        expect(node?.parsed.templateSelectors?.map((s) => s.value)).toEqual(["delete-workspace"]);
        // A template carries no code, so nothing should claim otherwise.
        expect(node?.ast).toBeUndefined();
        expect(node?.symbols).toEqual([]);
        graph.destroy();
    });

    it("makes a selector-only template findable by its test id wording", async () => {
        writeFile(
            "templates/settings.html",
            `<button data-testid="delete-workspace">Delete</button>`,
        );
        const graph = new CodeGraph(projectPath, {});

        await graph.scanProject();

        // Keyword search reads function and class names, which a template has
        // none of — without selector tokens this file is unreachable.
        expect(graph.findRelevantFiles("delete workspace flow", 5)).toContain(
            "templates/settings.html",
        );
        graph.destroy();
    });

    it("routes watcher 'unlink' events to removal even though the file is already gone", async () => {
        // Regression guard for the ordering bug where checking isBinaryFile()
        // before handling "unlink" would treat the now-missing file as
        // unreadable and skip removal entirely, leaving a ghost DB row.
        // Exercises the same private dispatcher startWatching() uses,
        // since driving a real chokidar watcher in a unit test is flaky.
        const filePath = writeFile("src/deleteme.ts", "export const gone = 1;\n");
        const events: UpdateEvent[] = [];
        const graph = new CodeGraph(projectPath, { onUpdate: (event) => events.push(event) });
        await graph.updateFile(filePath);
        expect(graph.getNode(filePath)).not.toBeUndefined();

        fs.rmSync(filePath);
        events.length = 0;
        const dispatch = (
            graph as unknown as {
                handleWatcherFileEvent: (
                    filePath: string,
                    eventType: "add" | "change" | "unlink",
                ) => Promise<void>;
            }
        ).handleWatcherFileEvent.bind(graph);
        await dispatch(filePath, "unlink");

        expect(graph.getNode(filePath)).toBeUndefined();
        expect(events).toHaveLength(1);
        expect(events[0]?.type).toBe("remove");
        graph.destroy();
    });
});
