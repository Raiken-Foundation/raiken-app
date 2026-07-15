import { describe, expect, it } from "vitest";
import { extractUrl, guessIntent, matchRoutes } from "../plan-heuristics";

describe("plan heuristics", () => {
    it("guesses generate / explore / explain intents", () => {
        expect(guessIntent("test the login flow")).toBe("generateTests");
        expect(guessIntent("cover checkout")).toBe("generateTests");
        expect(guessIntent("explore the dashboard")).toBe("explore");
        expect(guessIntent("explain how auth works")).toBe("explain");
        expect(guessIntent("hello")).toBe("unknown");
    });

    it("extracts URLs from prompts", () => {
        expect(extractUrl("open https://app.example.com/login now")).toBe(
            "https://app.example.com/login",
        );
        expect(extractUrl("no url here")).toBeNull();
    });

    it("ranks routes by token overlap", () => {
        const routes = [
            { url: "https://app.example.com/", title: "Home" },
            { url: "https://app.example.com/login", title: "Sign in" },
            { url: "https://app.example.com/checkout", title: "Checkout" },
        ];
        const hits = matchRoutes("test the login page", routes);
        expect(hits[0]).toContain("/login");
    });
});
