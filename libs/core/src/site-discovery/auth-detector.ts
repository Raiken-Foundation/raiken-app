/**
 * Authentication Detector
 *
 * Detects authentication requirements and login blockers on web pages.
 * Implements 5 detection patterns:
 * 1. URL patterns (e.g., /login, /signin)
 * 2. Login forms (password fields + submit buttons)
 * 3. OAuth buttons (e.g., "Sign in with Google")
 * 4. Error messages (e.g., "Access denied", "Unauthorized")
 * 5. HTTP status codes (401, 403)
 */

import type { Page, Response } from "playwright";
import type { AuthBlocker, AuthBlockerType } from "./types";

export class AuthDetector {
    private projectPath: string;

    constructor(projectPath: string) {
        this.projectPath = projectPath;
    }

    /**
     * Detect authentication requirements on a page.
     * Returns an AuthBlocker if detected, null otherwise.
     */
    async detect(
        page: Page,
        url: string,
        response?: Response
    ): Promise<AuthBlocker | null> {
        const now = Date.now();

        // Pattern 1: Check URL patterns
        if (this.checkUrlPatterns(url)) {
            return {
                projectPath: this.projectPath,
                url,
                blockerType: "url_pattern",
                detectedElements: JSON.stringify({ pattern: "login_url" }),
                resolvedAt: null,
                storageStatePath: null,
                discoveredAt: now,
            };
        }

        // Pattern 2: Check for login forms
        const loginForm = await this.checkLoginForm(page);
        if (loginForm) {
            return {
                projectPath: this.projectPath,
                url,
                blockerType: "login_form",
                detectedElements: JSON.stringify(loginForm),
                resolvedAt: null,
                storageStatePath: null,
                discoveredAt: now,
            };
        }

        // Pattern 3: Check for OAuth buttons
        const oauthButton = await this.checkOAuthButtons(page);
        if (oauthButton) {
            return {
                projectPath: this.projectPath,
                url,
                blockerType: "oauth_button",
                detectedElements: JSON.stringify(oauthButton),
                resolvedAt: null,
                storageStatePath: null,
                discoveredAt: now,
            };
        }

        // Pattern 4: Check for error messages
        const errorMessage = await this.checkErrorMessages(page);
        if (errorMessage) {
            return {
                projectPath: this.projectPath,
                url,
                blockerType: "error_message",
                detectedElements: JSON.stringify(errorMessage),
                resolvedAt: null,
                storageStatePath: null,
                discoveredAt: now,
            };
        }

        // Pattern 5: Check HTTP status
        if (response && this.checkHttpStatus(response)) {
            return {
                projectPath: this.projectPath,
                url,
                blockerType: "http_status",
                detectedElements: JSON.stringify({ status: response.status() }),
                resolvedAt: null,
                storageStatePath: null,
                discoveredAt: now,
            };
        }

        return null;
    }

    /**
     * Pattern 1: Check if URL matches common login patterns.
     */
    private checkUrlPatterns(url: string): boolean {
        const loginPatterns = [
            /\/login\/?/i,
            /\/signin\/?/i,
            /\/sign-in\/?/i,
            /\/auth\/?/i,
            /\/authenticate\/?/i,
            /\/log-in\/?/i,
        ];

        return loginPatterns.some((pattern) => pattern.test(url));
    }

    /**
     * Pattern 2: Check for login forms (password field + submit button).
     */
    private async checkLoginForm(
        page: Page
    ): Promise<{ passwordField: string; submitButton: string } | null> {
        try {
            // Look for password input field
            const passwordField = await page.locator('input[type="password"]').first();
            const passwordExists = (await passwordField.count()) > 0;

            if (!passwordExists) {
                return null;
            }

            // Look for submit button (various forms)
            const submitSelectors = [
                'button[type="submit"]',
                'input[type="submit"]',
                'button:has-text("sign in")',
                'button:has-text("log in")',
                'button:has-text("login")',
                'button:has-text("continue")',
            ];

            for (const selector of submitSelectors) {
                const button = await page.locator(selector).first();
                const buttonExists = (await button.count()) > 0;

                if (buttonExists) {
                    return {
                        passwordField: 'input[type="password"]',
                        submitButton: selector,
                    };
                }
            }

            // Password field exists but no obvious submit button - still likely a login form
            return {
                passwordField: 'input[type="password"]',
                submitButton: "unknown",
            };
        } catch (error) {
            return null;
        }
    }

    /**
     * Pattern 3: Check for OAuth/SSO buttons.
     */
    private async checkOAuthButtons(
        page: Page
    ): Promise<{ provider: string; text: string } | null> {
        try {
            const oauthPatterns = [
                { pattern: /sign in with google/i, provider: "Google" },
                { pattern: /sign in with github/i, provider: "GitHub" },
                { pattern: /sign in with microsoft/i, provider: "Microsoft" },
                { pattern: /sign in with apple/i, provider: "Apple" },
                { pattern: /sign in with facebook/i, provider: "Facebook" },
                { pattern: /continue with google/i, provider: "Google" },
                { pattern: /continue with github/i, provider: "GitHub" },
                { pattern: /log in with google/i, provider: "Google" },
                { pattern: /log in with github/i, provider: "GitHub" },
            ];

            // Get all buttons and links
            const content = await page.content();

            for (const { pattern, provider } of oauthPatterns) {
                if (pattern.test(content)) {
                    return {
                        provider,
                        text: content.match(pattern)?.[0] || `Sign in with ${provider}`,
                    };
                }
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Pattern 4: Check for error messages indicating auth required.
     */
    private async checkErrorMessages(
        page: Page
    ): Promise<{ message: string } | null> {
        try {
            const errorPatterns = [
                /access denied/i,
                /unauthorized/i,
                /please log in/i,
                /please sign in/i,
                /authentication required/i,
                /you must be logged in/i,
                /login required/i,
                /forbidden/i,
                /you don't have permission/i,
                /not authorized/i,
            ];

            const content = await page.content();

            for (const pattern of errorPatterns) {
                const match = content.match(pattern);
                if (match) {
                    return { message: match[0] };
                }
            }

            // Also check for common error elements
            const errorSelectors = [
                '.error',
                '.alert-danger',
                '.alert-error',
                '[role="alert"]',
                '.message-error',
            ];

            for (const selector of errorSelectors) {
                const element = await page.locator(selector).first();
                if ((await element.count()) > 0) {
                    const text = await element.textContent();
                    if (text) {
                        for (const pattern of errorPatterns) {
                            if (pattern.test(text)) {
                                return { message: text.trim() };
                            }
                        }
                    }
                }
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Pattern 5: Check HTTP response status for auth errors.
     */
    private checkHttpStatus(response: Response): boolean {
        const status = response.status();
        return status === 401 || status === 403;
    }
}
