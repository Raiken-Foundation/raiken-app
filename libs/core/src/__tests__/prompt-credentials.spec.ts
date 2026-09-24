/**
 * Credentials the user already typed must never trigger a "what are your
 * credentials?" pause — that pause is a dead end for `raiken -p`, CI, and
 * editor integrations.
 */
import { describe, expect, it } from "vitest";

import { extractLabeledValues } from "../agent/graph/nodes/classify-interruption";
import type { RequestedField } from "../agent/graph/utils";

const loginFields: RequestedField[] = [
    { key: "username", label: "Username", type: "text", selectors: ["#login-username"] },
    { key: "password", label: "Password", type: "password", selectors: ["#login-password"] },
];

describe("extractLabeledValues", () => {
    it("reads labelled credentials out of a one-shot prompt", () => {
        const values = extractLabeledValues(
            "sign in as username amelia with password pass1234, then open Projects",
            loginFields,
        );
        expect(values).toEqual({ username: "amelia", password: "pass1234" });
    });

    it("handles colon and equals separators, and strips quotes/punctuation", () => {
        const values = extractLabeledValues(
            'Log in with Username: "amelia", Password = pass1234.',
            loginFields,
        );
        expect(values).toEqual({ username: "amelia", password: "pass1234" });
    });

    it("treats 'sign in as <name>' as the identity when no label is given", () => {
        const values = extractLabeledValues(
            "log in as admin and check the danger zone",
            loginFields,
        );
        expect(values.username).toBe("admin");
        expect(values.password).toBeUndefined();
    });

    it("extracts nothing from a goal that never names a credential", () => {
        expect(extractLabeledValues("walk through the checkout flow", loginFields)).toEqual({});
    });

    it("never types a neighbouring field name as a value", () => {
        expect(
            extractLabeledValues("fill in the username and password fields", loginFields),
        ).toEqual({});
    });

    it("works for arbitrary field labels on any frontend, not just user/password", () => {
        const fields: RequestedField[] = [
            { key: "employee_id", label: "Employee ID", type: "text", selectors: ["#emp"] },
            { key: "pin", label: "PIN", type: "password", selectors: ["#pin"] },
        ];
        const values = extractLabeledValues("Employee ID: E-4471, PIN 8890", fields);
        expect(values).toEqual({ employee_id: "E-4471", pin: "8890" });
    });
});
