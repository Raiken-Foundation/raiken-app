import { describe, expect, it } from "vitest";
import { sfcFlavor, splitSfc } from "../sfc";
import { analyzeSourceFile, classifySourceFile } from "../source-analysis";

const VUE_SFC = `<template>
  <div>
    <button data-testid="save-workspace" @click="save">Save</button>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";

const name = ref<string>("");

function save(): void {
    name.value = "saved";
}
</script>

<style scoped>
button { color: red; }
</style>
`;

const SVELTE_COMPONENT = `<script lang="ts">
    export let projectId: string;

    function remove(): void {
        console.log(projectId);
    }
</script>

<button data-testid="remove-project" on:click={remove}>Remove</button>
<span aria-label="Project name">{projectId}</span>
`;

describe("sfcFlavor", () => {
    it("recognizes the two single-file component formats", () => {
        expect(sfcFlavor("src/components/Settings.vue")).toBe("vue");
        expect(sfcFlavor("src/routes/+page.svelte")).toBe("svelte");
        expect(sfcFlavor("src/app.ts")).toBe(null);
    });
});

describe("splitSfc", () => {
    it("keeps both halves line-aligned with the original file", () => {
        const split = splitSfc(VUE_SFC);
        const scriptLines = split.script.split("\n");
        const markupLines = split.markup.split("\n");

        expect(scriptLines).toHaveLength(VUE_SFC.split("\n").length);
        // `import { ref }` is on line 8 of the file, so it must be on line 8 here.
        expect(scriptLines[7]).toContain("import { ref }");
        // The template survives in the markup half; the script does not.
        expect(markupLines[2]).toContain('data-testid="save-workspace"');
        expect(split.markup).not.toContain("import { ref }");
        expect(split.script).not.toContain("data-testid");
    });

    it("detects TypeScript from the block's lang attribute", () => {
        expect(splitSfc(VUE_SFC).language).toBe("ts");
        expect(splitSfc(`<script>let a = 1;</script>`).language).toBe("js");
    });

    it("drops style blocks from the markup half", () => {
        expect(splitSfc(VUE_SFC).markup).not.toContain("color: red");
    });

    it("reports a component with no script block", () => {
        const split = splitSfc(`<template><p>Static</p></template>`);
        expect(split.hasScript).toBe(false);
        expect(split.script.trim()).toBe("");
    });
});

describe("classifySourceFile", () => {
    it("routes each file to the analyzer that can read it", () => {
        expect(classifySourceFile("src/app.tsx")).toBe("script");
        expect(classifySourceFile("src/App.vue")).toBe("sfc");
        expect(classifySourceFile("templates/index.html.erb")).toBe("markup");
        expect(classifySourceFile("app/models/user.rb")).toBe(null);
    });
});

describe("analyzeSourceFile", () => {
    it("extracts symbols and template selectors from a Vue SFC", () => {
        const result = analyzeSourceFile(VUE_SFC, "src/components/Settings.vue");

        expect(result?.kind).toBe("sfc");
        expect(result?.ast).toBeDefined();
        expect(result?.parsed.functions.map((f) => f.name)).toContain("save");
        expect(result?.parsed.imports.map((i) => i.source)).toEqual(["vue"]);
        expect(result?.parsed.templateSelectors).toEqual([
            { kind: "testId", value: "save-workspace", attribute: "data-testid", line: 3 },
        ]);
    });

    it("reports symbols at their real line in the file, not the script block", () => {
        const save = analyzeSourceFile(VUE_SFC, "Settings.vue")?.parsed.functions.find(
            (f) => f.name === "save",
        );
        // `function save` sits on line 12 of the component, six lines below the
        // start of its <script> block.
        expect(save?.line).toBe(12);
    });

    it("handles a Svelte component, whose markup has no template wrapper", () => {
        const result = analyzeSourceFile(SVELTE_COMPONENT, "src/lib/Project.svelte");

        expect(result?.parsed.functions.map((f) => f.name)).toContain("remove");
        expect(result?.parsed.templateSelectors?.map((s) => s.value)).toEqual([
            "remove-project",
            "Project name",
        ]);
    });

    // Previously any SFC produced an empty node. Half a component is strictly
    // better than that, and the selectors are the half tests need most.
    it("still returns template selectors when the script block is broken", () => {
        const broken = `<template><b data-testid="still-here">x</b></template>
<script>
const = ;
</script>`;

        const result = analyzeSourceFile(broken, "Broken.vue");

        expect(result?.parseError).toBeTruthy();
        expect(result?.ast).toBeUndefined();
        expect(result?.parsed.templateSelectors?.map((s) => s.value)).toEqual(["still-here"]);
    });

    it("reads a server-rendered template with no code at all", () => {
        const result = analyzeSourceFile(
            `<div><button data-testid="delete-account">Delete</button></div>`,
            "templates/account.html",
        );

        expect(result?.kind).toBe("markup");
        expect(result?.ast).toBeUndefined();
        expect(result?.parsed.templateSelectors?.map((s) => s.value)).toEqual(["delete-account"]);
    });

    it("omits the selector field entirely when a template has none", () => {
        const result = analyzeSourceFile("<p>nothing here</p>", "templates/plain.html");
        expect(result?.parsed.templateSelectors).toBeUndefined();
    });

    it("parses ordinary scripts exactly as before", () => {
        const result = analyzeSourceFile("export const a = 1;", "src/a.ts");
        expect(result?.kind).toBe("script");
        expect(result?.parsed.exports).toContain("a");
    });

    it("propagates a genuine script parse error rather than hiding it", () => {
        expect(() => analyzeSourceFile("const = ;", "src/a.ts")).toThrow(/Parse error/);
    });

    it("leaves files it cannot read to the caller", () => {
        expect(analyzeSourceFile("def main(): pass", "main.py")).toBe(null);
    });

    it("honors a configured extension allowlist for unusual script extensions", () => {
        const result = analyzeSourceFile("export const a = 1;", "src/a.es6", {
            unknownAsScript: true,
        });
        expect(result?.kind).toBe("script");
    });
});
