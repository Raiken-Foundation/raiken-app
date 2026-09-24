import { describe, expect, it } from "vitest";
import {
    describeTemplateSelectors,
    extractTemplateSelectors,
    isMarkupFile,
} from "../markup-selectors";

const values = (markup: string) => extractTemplateSelectors(markup).map((s) => s.value);

/** Lets a case assert on a literal `${...}` without interpolating it here. */
const DOLLAR = "$";

describe("isMarkupFile", () => {
    it("recognizes the template dialects of backends we cannot parse", () => {
        for (const file of [
            "templates/settings.html",
            "app/views/projects/index.html.erb",
            "resources/views/settings.blade.php",
            "templates/base.jinja2",
            "views/partials/nav.hbs",
            "views/settings.ejs",
            "templates/settings.html.twig",
            "src/pages/index.astro",
        ]) {
            expect(isMarkupFile(file), file).toBe(true);
        }
    });

    it("does not claim source files it cannot read as markup", () => {
        for (const file of ["src/app.ts", "src/App.tsx", "main.py", "app/models/user.rb"]) {
            expect(isMarkupFile(file), file).toBe(false);
        }
    });
});

describe("extractTemplateSelectors", () => {
    it("reads test ids, labels, placeholders, and roles out of plain HTML", () => {
        const selectors = extractTemplateSelectors(`
<div role="alertdialog">
  <input placeholder="Workspace name" aria-label="Workspace name field" />
  <button data-testid="delete-workspace">Delete</button>
</div>
`);

        expect(selectors).toEqual([
            { kind: "role", value: "alertdialog", line: 2 },
            { kind: "placeholder", value: "Workspace name", line: 3 },
            { kind: "label", value: "Workspace name field", line: 3 },
            { kind: "testId", value: "delete-workspace", attribute: "data-testid", line: 4 },
        ]);
    });

    it("records which attribute supplied a test id, since projects differ", () => {
        const selectors = extractTemplateSelectors(
            `<a data-cy="signout">Out</a><a data-test="signin">In</a>`,
        );
        expect(selectors.map((s) => [s.attribute, s.value])).toEqual([
            ["data-cy", "signout"],
            ["data-test", "signin"],
        ]);
    });

    // The whole point of the exercise: a value assembled at render time is not a
    // selector, and offering it to the model invents an element.
    describe("rejects values that are computed at render time", () => {
        it.each([
            ["Django / Jinja / Twig", `<b data-testid="{{ row.id }}">x</b>`],
            ["Jinja statement", `<b data-testid="{% if x %}a{% endif %}">x</b>`],
            ["ERB", `<b data-testid="<%= dom_id(task) %>">x</b>`],
            ["Blade", `<b data-testid="task-{{ $task->id }}">x</b>`],
            ["template literal", `<b data-testid="task-${DOLLAR}{id}">x</b>`],
            ["Ruby interpolation", `<b data-testid="task-#{task.id}">x</b>`],
        ])("%s", (_dialect, markup) => {
            expect(values(markup)).toEqual([]);
        });

        it.each([
            ["Vue shorthand binding", `<b :data-testid="rowId">x</b>`],
            ["Vue long-form binding", `<b v-bind:data-testid="rowId">x</b>`],
            ["Angular binding", `<b [attr.data-testid]="rowId">x</b>`],
            ["Alpine binding", `<b x-bind:data-testid="rowId">x</b>`],
        ])("%s", (_dialect, markup) => {
            expect(values(markup)).toEqual([]);
        });
    });

    it("ignores commented-out markup across dialects", () => {
        expect(values(`<!-- <b data-testid="old-button">x</b> -->`)).toEqual([]);
        expect(values(`{# <b data-testid="jinja-old">x</b> #}`)).toEqual([]);
        expect(values(`{{-- <b data-testid="blade-old">x</b> --}}`)).toEqual([]);
        expect(values(`<%# <b data-testid="erb-old">x</b> %>`)).toEqual([]);
    });

    it("ignores attribute-looking strings inside script and style islands", () => {
        const markup = `
<script>
  const html = '<div data-testid="from-script"></div>';
</script>
<style>.x[data-testid="from-style"] { color: red; }</style>
<button data-testid="real-button">Go</button>
`;
        expect(values(markup)).toEqual(["real-button"]);
    });

    it("keeps line numbers pointing at the original source", () => {
        const markup = ["<div>", "  <!-- filler -->", "", '  <b data-testid="deep">x</b>'].join(
            "\n",
        );
        expect(extractTemplateSelectors(markup)[0]?.line).toBe(4);
    });

    it("deduplicates a selector repeated across a list", () => {
        const rows = Array.from(
            { length: 5 },
            () => `<tr><td data-testid="row-actions">x</td></tr>`,
        ).join("\n");
        expect(values(rows)).toEqual(["row-actions"]);
    });

    it("caps a huge template, keeping test ids over bare roles", () => {
        const roles = Array.from({ length: 80 }, (_, i) => `<div role="role-${i}"></div>`).join(
            "\n",
        );
        const testIds = Array.from(
            { length: 10 },
            (_, i) => `<b data-testid="action-${i}">x</b>`,
        ).join("\n");

        const selectors = extractTemplateSelectors(`${roles}\n${testIds}`);

        expect(selectors).toHaveLength(60);
        expect(selectors.filter((s) => s.kind === "testId")).toHaveLength(10);
    });

    it("returns nothing for markup with no attributes at all", () => {
        expect(extractTemplateSelectors("<p>Just text</p>")).toEqual([]);
    });
});

describe("describeTemplateSelectors", () => {
    it("groups by kind and names the test id attribute", () => {
        const described = describeTemplateSelectors([
            { kind: "testId", value: "delete-workspace", attribute: "data-cy", line: 1 },
            { kind: "testId", value: "confirm", attribute: "data-cy", line: 2 },
            { kind: "role", value: "alertdialog", line: 3 },
        ]);

        expect(described).toBe("test ids (data-cy): delete-workspace, confirm\nroles: alertdialog");
    });

    it("says nothing when there is nothing to say", () => {
        expect(describeTemplateSelectors([])).toBe("");
    });
});
