import { describe, expect, it } from "vitest";
import { assertHttpUrl } from "../url-guard";

/**
 * Pins the URL-scheme guardrail (review finding, agent-tools): zod's
 * z.string().url() accepts file:/javascript:/data: — and graph-node callers
 * bypass zod entirely. execute-side validation must reject everything but
 * http/https so a model-authored file:// URL can never point the browser at
 * local files.
 */
describe("assertHttpUrl", () => {
    it("accepts http and https URLs", () => {
        expect(() => assertHttpUrl("http://localhost:3000/login")).not.toThrow();
        expect(() => assertHttpUrl("https://app.example/path?a=1")).not.toThrow();
    });

    it("rejects file, javascript, and data schemes", () => {
        expect(() => assertHttpUrl("file:///Users/x/.env")).toThrow(/scheme is not allowed/);
        expect(() => assertHttpUrl("javascript:alert(1)")).toThrow(/scheme is not allowed/);
        expect(() => assertHttpUrl("data:text/html,<h1>x</h1>")).toThrow(/scheme is not allowed/);
    });

    it("rejects unparseable URLs", () => {
        expect(() => assertHttpUrl("not a url")).toThrow(/not a parseable URL/);
    });
});
