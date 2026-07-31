import { describe, expect, it } from "vitest";
import { type DOMContext, formatDOMContext } from "../browser/dom-capture";

function baseDom(overrides: Partial<DOMContext> = {}): DOMContext {
    return {
        url: "https://example.com/login",
        title: "Login",
        accessibilityTree: null,
        timestamp: 0,
        interactiveElements: [],
        formFields: [],
        ...overrides,
    };
}

describe("formatDOMContext — FORM FIELDS", () => {
    it("renders captured form fields with their suggested selectors", () => {
        const out = formatDOMContext(
            baseDom({
                formFields: [
                    {
                        name: "email",
                        type: "email",
                        label: "Email address",
                        required: true,
                        suggestedSelector: "getByLabel('Email address')",
                    },
                    {
                        name: "password",
                        type: "password",
                        placeholder: "Your password",
                        required: false,
                        suggestedSelector: "getByPlaceholder('Your password')",
                    },
                ],
            }),
        );

        expect(out).toContain("FORM FIELDS:");
        expect(out).toContain('"Email address"');
        expect(out).toContain("[type=email]");
        expect(out).toContain("[required]");
        expect(out).toContain("getByLabel('Email address')");
        expect(out).toContain("getByPlaceholder('Your password')");
    });

    it("omits the FORM FIELDS section when there are no fields", () => {
        const out = formatDOMContext(baseDom({ formFields: [] }));
        expect(out).not.toContain("FORM FIELDS:");
    });
});
