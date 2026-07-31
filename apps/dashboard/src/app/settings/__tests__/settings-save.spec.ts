import { describe, expect, it } from "vitest";
import { formatSaveValidationError, parseSaveResponse } from "../use-settings-save";

describe("settings save feedback", () => {
    it("formats validation errors from the server", () => {
        expect(formatSaveValidationError(["ai.maxTokens must be positive"])).toBe(
            "Invalid configuration — ai.maxTokens must be positive",
        );
        expect(formatSaveValidationError([])).toBe("Invalid configuration.");
        expect(formatSaveValidationError(undefined)).toBe("Invalid configuration.");
    });

    it("treats success:false responses as validation failures", () => {
        expect(parseSaveResponse({ success: false, errors: ["browser.timeout invalid"] })).toEqual({
            ok: false,
            error: "Invalid configuration — browser.timeout invalid",
        });
    });

    it("accepts successful save responses", () => {
        expect(parseSaveResponse({ success: true })).toEqual({ ok: true });
        expect(parseSaveResponse(undefined)).toEqual({ ok: true });
    });
});
