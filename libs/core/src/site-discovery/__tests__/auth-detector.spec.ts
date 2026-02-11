/**
 * Auth Detector Tests
 */

import { describe, it, expect } from "vitest";
import { AuthDetector } from "../auth-detector";

describe("AuthDetector", () => {
    const detector = new AuthDetector("/test/project");

    describe("URL Pattern Detection", () => {
        it("should detect /login URL", () => {
            const result = (detector as any).checkUrlPatterns(
                "http://localhost:3000/login"
            );
            expect(result).toBe(true);
        });

        it("should detect /signin URL", () => {
            const result = (detector as any).checkUrlPatterns(
                "http://localhost:3000/signin"
            );
            expect(result).toBe(true);
        });

        it("should detect /auth URL", () => {
            const result = (detector as any).checkUrlPatterns(
                "http://localhost:3000/auth"
            );
            expect(result).toBe(true);
        });

        it("should not detect regular URLs", () => {
            const result = (detector as any).checkUrlPatterns(
                "http://localhost:3000/dashboard"
            );
            expect(result).toBe(false);
        });
    });

    describe("OAuth Detection", () => {
        it("should detect Google OAuth button", async () => {
            const mockPage = {
                content: async () =>
                    "<html><body><button>Sign in with Google</button></body></html>",
            };

            const result = await (detector as any).checkOAuthButtons(mockPage);
            expect(result).toBeTruthy();
            expect(result?.provider).toBe("Google");
        });

        it("should detect GitHub OAuth button", async () => {
            const mockPage = {
                content: async () =>
                    "<html><body><button>Sign in with GitHub</button></body></html>",
            };

            const result = await (detector as any).checkOAuthButtons(mockPage);
            expect(result).toBeTruthy();
            expect(result?.provider).toBe("GitHub");
        });

        it("should return null for non-OAuth pages", async () => {
            const mockPage = {
                content: async () =>
                    "<html><body><button>Submit</button></body></html>",
            };

            const result = await (detector as any).checkOAuthButtons(mockPage);
            expect(result).toBeNull();
        });
    });

    describe("Error Message Detection", () => {
        it("should detect 'Access denied' message", async () => {
            const mockPage = {
                content: async () =>
                    "<html><body><div class='error'>Access denied</div></body></html>",
                locator: () => ({
                    first: () => ({
                        count: async () => 0,
                        textContent: async () => null,
                    }),
                }),
            };

            const result = await (detector as any).checkErrorMessages(mockPage);
            expect(result).toBeTruthy();
            expect(result?.message).toContain("Access denied");
        });

        it("should detect 'Unauthorized' message", async () => {
            const mockPage = {
                content: async () =>
                    "<html><body><div>Unauthorized access</div></body></html>",
                locator: () => ({
                    first: () => ({
                        count: async () => 0,
                        textContent: async () => null,
                    }),
                }),
            };

            const result = await (detector as any).checkErrorMessages(mockPage);
            expect(result).toBeTruthy();
            expect(result?.message).toContain("Unauthorized");
        });

        it("should return null for normal pages", async () => {
            const mockPage = {
                content: async () =>
                    "<html><body><div>Welcome to the dashboard</div></body></html>",
                locator: () => ({
                    first: () => ({
                        count: async () => 0,
                        textContent: async () => null,
                    }),
                }),
            };

            const result = await (detector as any).checkErrorMessages(mockPage);
            expect(result).toBeNull();
        });
    });

    describe("HTTP Status Detection", () => {
        it("should detect 401 status", () => {
            const mockResponse = {
                status: () => 401,
            };

            const result = (detector as any).checkHttpStatus(mockResponse);
            expect(result).toBe(true);
        });

        it("should detect 403 status", () => {
            const mockResponse = {
                status: () => 403,
            };

            const result = (detector as any).checkHttpStatus(mockResponse);
            expect(result).toBe(true);
        });

        it("should not detect 200 status", () => {
            const mockResponse = {
                status: () => 200,
            };

            const result = (detector as any).checkHttpStatus(mockResponse);
            expect(result).toBe(false);
        });

        it("should not detect 404 status", () => {
            const mockResponse = {
                status: () => 404,
            };

            const result = (detector as any).checkHttpStatus(mockResponse);
            expect(result).toBe(false);
        });
    });
});
