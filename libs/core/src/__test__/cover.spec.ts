import { describe, expect, it } from "vitest";
import { extractAcs } from "../cover/cover";

describe("raiken cover: extractAcs", () => {
    it("prefers AC-prefixed lines when present", () => {
        const desc = `
        AC1: User can log in with email
        AC2: User sees a welcome banner
        - [ ] Stray checkbox that should be ignored
        `;
        const acs = extractAcs(desc);
        expect(acs).toEqual(["User can log in with email", "User sees a welcome banner"]);
    });

    it("falls back to checkboxes when no AC prefix", () => {
        const desc = `
        Criteria:
        - [ ] Render login form
        - [x] Validate email format
        1. Numbered items are ignored when checkboxes exist
        `;
        const acs = extractAcs(desc);
        expect(acs).toEqual(["Render login form", "Validate email format"]);
    });

    it("falls back to numbered list when nothing else is present", () => {
        const desc = `
        Acceptance criteria:
        1. Click the CTA
        2. See the modal
        3. Submit the form
        `;
        const acs = extractAcs(desc);
        expect(acs).toEqual(["Click the CTA", "See the modal", "Submit the form"]);
    });

    it("handles AC-1, AC 1, AC:1 variants", () => {
        const desc = `
        AC-1: Alpha
        AC 2: Beta
        AC:3: Gamma
        `;
        const acs = extractAcs(desc);
        expect(acs).toEqual(["Alpha", "Beta", "Gamma"]);
    });

    it("returns [] for a description with no AC-like content", () => {
        expect(extractAcs("Just some prose, nothing testable.")).toEqual([]);
    });
});
