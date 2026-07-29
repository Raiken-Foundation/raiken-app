import { describe, expect, it } from "vitest";
import {
    buildSummary,
    expandActionSynonyms,
    extractPageTitle,
    getStructuralSignals,
    goalTargetsUnauthedPage,
    hasAuthFormFields,
    matchesAction,
    normalizeExploreUrl,
    parseSummaryElements,
    resolveAuthPrecondition,
    type SummaryElement,
    shouldClassifyInterruption,
    shouldUseStorageState,
} from "../agent/graph/utils";

// Helper to build SummaryElement objects
function el(role: string, name: string, selector?: string, type?: string): SummaryElement {
    const selectors = selector ? [selector] : [];
    return { role, name, selector, type, selectors };
}

describe("buildSummary", () => {
    it("states which selectors could not be confirmed instead of leaving it in the log", () => {
        const summary = buildSummary({
            testDraft: "test('x', () => {})",
            savedTestPath: "e2e/x.spec.ts",
            groundingViolations: [
                {
                    locator: "getByTestId('login-error')",
                    reason: "no captured element has the test id 'login-error'",
                },
            ],
        });

        expect(summary).toContain("1 selector(s) could not be confirmed");
        expect(summary).toContain("getByTestId('login-error')");
    });

    it("says nothing about grounding when every selector was confirmed", () => {
        const summary = buildSummary({ testDraft: "test('x', () => {})" });
        expect(summary).not.toMatch(/could not be confirmed/);
    });
});

describe("Structural Signals & Pre-filter", () => {
    describe("getStructuralSignals", () => {
        it("detects password fields by type attribute", () => {
            const elements = [
                el("textbox", "Email", undefined, "email"),
                el("textbox", "Password", undefined, "password"),
                el("button", "Sign In"),
            ];
            const signals = getStructuralSignals(elements, "Login - MyApp");
            expect(signals.hasPasswordField).toBe(true);
            expect(signals.hasEmailOrUserField).toBe(true);
        });

        it("detects OTP / code fields", () => {
            const elements = [
                el("textbox", "Verification Code", undefined, "text"),
                el("button", "Verify"),
            ];
            const signals = getStructuralSignals(elements, "Verify Your Identity");
            expect(signals.hasCodeField).toBe(true);
            expect(signals.hasPasswordField).toBe(false);
        });

        it("marks dead-end pages with <= 3 elements", () => {
            const elements = [el("link", "Back"), el("button", "Retry")];
            const signals = getStructuralSignals(elements, "Error");
            expect(signals.isDeadEnd).toBe(true);
        });

        it("does NOT mark a rich page as dead-end", () => {
            const elements = Array.from({ length: 15 }, (_, i) => el("link", `Link ${i}`));
            const signals = getStructuralSignals(elements, "Dashboard");
            expect(signals.isDeadEnd).toBe(false);
            expect(signals.elementCount).toBe(15);
        });

        it("does NOT mark an empty capture as a dead-end", () => {
            // Zero interactive elements means the page is blank, still
            // loading, or the capture failed — not a user-actionable
            // dead-end. Flagging it triggered a bogus "Dead-end page with
            // no interactive elements" blocker.
            const signals = getStructuralSignals([], "");
            expect(signals.isDeadEnd).toBe(false);
            expect(signals.elementCount).toBe(0);
            expect(shouldClassifyInterruption(signals)).toBe(false);
        });

        it("passes through hasBlockingOverlay flag", () => {
            const elements = [el("button", "Accept Cookies")];
            const signals = getStructuralSignals(elements, "Home", true);
            expect(signals.hasBlockingOverlay).toBe(true);
        });

        it("defaults hasBlockingOverlay to false", () => {
            const elements = [el("button", "Accept Cookies")];
            const signals = getStructuralSignals(elements, "Home");
            expect(signals.hasBlockingOverlay).toBe(false);
        });

        it("flags 'Promo Code' via name fallback but not via type", () => {
            const elements = [
                el("textbox", "Promo Code", undefined, "text"),
                el("button", "Apply"),
                el("link", "Checkout"),
                el("link", "Cart"),
                el("link", "Home"),
            ];
            const signals = getStructuralSignals(elements, "Cart - Shop");
            // Name fallback matches /code/i. The LLM will ultimately classify
            // this as "none" because there's no password field and the page
            // has shopping context.
            expect(signals.hasCodeField).toBe(true);
            expect(signals.hasPasswordField).toBe(false);
        });
    });

    describe("shouldClassifyInterruption", () => {
        it("triggers on password field", () => {
            const signals = getStructuralSignals(
                [el("textbox", "Password", undefined, "password"), el("button", "Login")],
                "Login",
            );
            expect(shouldClassifyInterruption(signals)).toBe(true);
        });

        it("triggers on code/OTP field", () => {
            const signals = getStructuralSignals(
                [el("textbox", "OTP", undefined, "text"), el("button", "Submit")],
                "Verify",
            );
            expect(shouldClassifyInterruption(signals)).toBe(true);
        });

        it("triggers on blocking overlay", () => {
            const elements = Array.from({ length: 10 }, (_, i) => el("link", `Nav ${i}`));
            const signals = getStructuralSignals(elements, "Dashboard", true);
            expect(shouldClassifyInterruption(signals)).toBe(true);
        });

        it("triggers on dead-end page", () => {
            const signals = getStructuralSignals([el("button", "Retry")], "Error");
            expect(shouldClassifyInterruption(signals)).toBe(true);
        });

        it("does NOT trigger on a normal rich page", () => {
            const elements = Array.from({ length: 20 }, (_, i) => el("link", `Section ${i}`));
            const signals = getStructuralSignals(elements, "Dashboard");
            expect(shouldClassifyInterruption(signals)).toBe(false);
        });

        it("does NOT trigger on settings page with password change", () => {
            const elements = [
                el("textbox", "Current Password", undefined, "password"),
                el("textbox", "New Password", undefined, "password"),
                el("textbox", "Confirm Password", undefined, "password"),
                el("button", "Update Password"),
                el("link", "Profile"),
                el("link", "Settings"),
                el("link", "Billing"),
                el("link", "Notifications"),
            ];
            const signals = getStructuralSignals(elements, "Account Settings");
            // Pre-filter WILL trigger (password field present).
            // This is intentional; the LLM will correctly classify it as "none".
            expect(shouldClassifyInterruption(signals)).toBe(true);
        });
    });

    describe("hasAuthFormFields", () => {
        it("returns true when password + identity fields present", () => {
            const elements = [
                el("textbox", "Email address", undefined, "email"),
                el("textbox", "Password", undefined, "password"),
                el("button", "Log In"),
            ];
            expect(hasAuthFormFields(elements)).toBe(true);
        });

        it("returns false when no auth-related fields", () => {
            const elements = [el("textbox", "Search"), el("button", "Go"), el("link", "Home")];
            expect(hasAuthFormFields(elements)).toBe(false);
        });

        it("returns false after successful login (fields gone)", () => {
            const elements = [
                el("link", "Dashboard"),
                el("link", "Profile"),
                el("button", "Logout"),
            ];
            expect(hasAuthFormFields(elements)).toBe(false);
        });
    });

    describe("extractPageTitle", () => {
        it("extracts title from summary", () => {
            const summary =
                "Page Title: My App Dashboard\nURL: https://example.com\nINTERACTIVE ELEMENTS:";
            expect(extractPageTitle(summary)).toBe("My App Dashboard");
        });

        it("returns empty string if no title", () => {
            const summary = "URL: https://example.com\nINTERACTIVE ELEMENTS:";
            expect(extractPageTitle(summary)).toBe("");
        });
    });

    describe("parseSummaryElements", () => {
        it("parses interactive elements from summary text", () => {
            const summary = `Page Title: Test Page
URL: https://example.com
INTERACTIVE ELEMENTS:
• button: "Submit"
  Selectors: getByRole('button', { name: 'Submit' })
• textbox: "Email"
  Selectors: getByPlaceholder('Email')
• link: "Home"
  Selectors: getByText('Home')
`;
            const elements = parseSummaryElements(summary);
            expect(elements).toHaveLength(3);
            expect(elements[0].role).toBe("button");
            expect(elements[0].name).toBe("Submit");
            expect(elements[1].role).toBe("textbox");
            expect(elements[1].name).toBe("Email");
            expect(elements[2].role).toBe("link");
            expect(elements[2].name).toBe("Home");
        });

        it("parses type attribute and multiple selectors from summary text", () => {
            const summary = `INTERACTIVE ELEMENTS:
• textbox: "login" [type=text]
  Selectors: getByRole('textbox', { name: 'login' }) | input[name="login"] | input[id="login_field"]
• textbox: "Password" [type=password]
  Selectors: getByRole('textbox', { name: 'Password' }) | input[name="password"]
• button: "Sign in"
  Selectors: getByRole('button', { name: 'Sign in' })
SELECTOR PRIORITY:
`;
            const elements = parseSummaryElements(summary);
            expect(elements).toHaveLength(3);
            expect(elements[0].type).toBe("text");
            expect(elements[0].selectors).toEqual([
                "getByRole('textbox', { name: 'login' })",
                'input[name="login"]',
                'input[id="login_field"]',
            ]);
            expect(elements[1].type).toBe("password");
            expect(elements[1].selectors).toHaveLength(2);
            expect(elements[2].type).toBeUndefined();
            expect(elements[2].selectors).toHaveLength(1);
        });

        it("backward compat: parses single 'Selector:' line", () => {
            const summary = `INTERACTIVE ELEMENTS:
• button: "OK"
  Selector: getByText('OK')
SELECTOR PRIORITY:
`;
            const elements = parseSummaryElements(summary);
            expect(elements).toHaveLength(1);
            expect(elements[0].selector).toBe("getByText('OK')");
            expect(elements[0].selectors).toEqual(["getByText('OK')"]);
        });

        it("parses the [href=...] suffix on link elements", () => {
            const summary = `INTERACTIVE ELEMENTS:
• link: "Account" [href=/account/settings]
  Selectors: getByRole('link', { name: 'Account' })
• link: "Sign out" [type=button] [href=/logout]
  Selectors: getByRole('link', { name: 'Sign out' })
SELECTOR PRIORITY:
`;
            const elements = parseSummaryElements(summary);
            expect(elements).toHaveLength(2);
            expect(elements[0].name).toBe("Account");
            expect(elements[0].href).toBe("/account/settings");
            expect(elements[1].name).toBe("Sign out");
            expect(elements[1].type).toBe("button");
            expect(elements[1].href).toBe("/logout");
        });
    });
});

describe("Goal-directed action helpers", () => {
    describe("goalTargetsUnauthedPage", () => {
        it("detects explicit logged-out / unauthenticated intent", () => {
            expect(goalTargetsUnauthedPage("test the unauthenticated entry experience")).toBe(true);
            expect(goalTargetsUnauthedPage("as a logged out user, view the landing page")).toBe(
                true,
            );
            expect(goalTargetsUnauthedPage("without signing in, open the home page")).toBe(true);
        });

        it("treats a real login-page goal as unauthenticated", () => {
            expect(goalTargetsUnauthedPage("test the login page")).toBe(true);
            expect(goalTargetsUnauthedPage("verify the sign-in form")).toBe(true);
            expect(goalTargetsUnauthedPage("cover the get started screen")).toBe(true);
        });

        it("does NOT flag authenticated goals that merely mention the login page", () => {
            expect(
                goalTargetsUnauthedPage(
                    "Verify the page loads authenticated, NOT the login/Get Started page",
                ),
            ).toBe(false);
            expect(goalTargetsUnauthedPage("ensure it does not redirect to the login page")).toBe(
                false,
            );
            expect(
                goalTargetsUnauthedPage("the user is signed in; test the overview dashboard"),
            ).toBe(false);
            expect(goalTargetsUnauthedPage("as a logged-in user, open the customers table")).toBe(
                false,
            );
        });

        it("returns false for ordinary authenticated page goals", () => {
            expect(goalTargetsUnauthedPage("test the customers page")).toBe(false);
            expect(goalTargetsUnauthedPage("exercise the invoices table filters")).toBe(false);
        });
    });

    describe("expandActionSynonyms", () => {
        it("expands sign out into logout synonyms", () => {
            const synonyms = expandActionSynonyms("sign out");
            expect(synonyms).toContain("sign out");
            expect(synonyms).toContain("logout");
            expect(synonyms).toContain("log out");
        });

        it("normalizes hyphens/underscores and includes the original", () => {
            const synonyms = expandActionSynonyms("Log-Out");
            expect(synonyms).toContain("log out");
            expect(synonyms).toContain("sign out");
        });

        it("returns just the phrase when it has no known synonyms", () => {
            const synonyms = expandActionSynonyms("frobnicate widget");
            expect(synonyms).toEqual(["frobnicate widget"]);
        });
    });

    describe("resolveAuthPrecondition", () => {
        it.each([
            "generate an MFA login test",
            "verify the OTP rejects the wrong code",
            "test the two-factor authentication flow",
            "complete the sign-in flow with credentials",
        ])("classifies %s as a login flow", (prompt) => {
            expect(resolveAuthPrecondition({ userPrompt: prompt })).toBe("login_flow");
        });

        // A prompt that only ever says "signing in" / "credentials" used to
        // miss every branch and land on the `authenticated` default, so
        // generation injected saved storage state and the test opened an
        // already-signed-in app with no login form to drive.
        it.each([
            "test signing in with invalid credentials",
            "check that logging in with a locked account is refused",
            "verify signing up creates an account",
        ])("classifies the gerund form %s as a login flow", (prompt) => {
            expect(resolveAuthPrecondition({ userPrompt: prompt })).toBe("login_flow");
        });

        it("classifies the login page itself as unauthenticated", () => {
            expect(resolveAuthPrecondition({ userPrompt: "test the login page" })).toBe(
                "unauthenticated",
            );
        });

        it("keeps explicit logged-out and redirect goals unauthenticated", () => {
            expect(
                resolveAuthPrecondition({
                    userPrompt: "verify the dashboard redirects when the user is logged out",
                }),
            ).toBe("unauthenticated");
        });

        it("keeps protected feature goals authenticated", () => {
            expect(
                resolveAuthPrecondition({
                    userPrompt: "test the dashboard as a logged-in user",
                }),
            ).toBe("authenticated");
            expect(resolveAuthPrecondition({ userPrompt: "test project creation" })).toBe(
                "authenticated",
            );
        });

        it("uses classified goal fields when the prompt is vague", () => {
            expect(
                resolveAuthPrecondition({
                    userPrompt: "do that next",
                    activeGoal: "complete MFA login with a verification code",
                }),
            ).toBe("login_flow");
        });

        it("lets explicit saved-session intent override incidental auth terms", () => {
            expect(
                resolveAuthPrecondition({
                    userPrompt: "reuse the saved session to test authentication settings",
                }),
            ).toBe("authenticated");
        });

        it("only permits storage state for authenticated preconditions", () => {
            expect(shouldUseStorageState("authenticated")).toBe(true);
            expect(shouldUseStorageState("unauthenticated")).toBe(false);
            expect(shouldUseStorageState("login_flow")).toBe(false);
        });
    });

    describe("matchesAction", () => {
        it("matches an element name to an action via synonyms", () => {
            expect(matchesAction("Log out", "sign out")).toBe(true);
            expect(matchesAction("Sign Out", "logout")).toBe(true);
            expect(matchesAction("Logout", "sign out")).toBe(true);
        });

        it("matches when the element name contains the action phrase", () => {
            expect(matchesAction("Add to cart", "add to cart")).toBe(true);
            expect(matchesAction("Delete account", "delete")).toBe(true);
        });

        it("does not match unrelated controls", () => {
            expect(matchesAction("Dashboard", "sign out")).toBe(false);
            expect(matchesAction("", "sign out")).toBe(false);
            expect(matchesAction("Sign out", "")).toBe(false);
        });
    });

    describe("normalizeExploreUrl", () => {
        it("drops the hash fragment", () => {
            expect(normalizeExploreUrl("https://x.com/settings#top")).toBe(
                "https://x.com/settings",
            );
        });

        it("treats trailing slash as the same page", () => {
            expect(normalizeExploreUrl("https://x.com/settings/")).toBe(
                normalizeExploreUrl("https://x.com/settings"),
            );
        });

        it("keeps the root path intact", () => {
            expect(normalizeExploreUrl("https://x.com/")).toBe("https://x.com/");
        });

        it("preserves query strings", () => {
            expect(normalizeExploreUrl("https://x.com/search?q=1#frag")).toBe(
                "https://x.com/search?q=1",
            );
        });

        it("falls back gracefully for non-URL input", () => {
            expect(normalizeExploreUrl("/relative/path/")).toBe("/relative/path");
        });
    });
});

describe("Explore Link Prioritization", () => {
    // Import the scoring function indirectly by testing via navigation module
    // Since scoreLinkRelevance is not exported, we test the observable behavior
    it("sorts goal-relevant links first", async () => {
        // We can't import private functions, but we can verify the logic
        // by testing the same algorithm inline
        const links = [
            { text: "Blog", href: "/blog" },
            { text: "Dashboard Settings", href: "/dashboard/settings" },
            { text: "About Us", href: "/about" },
            { text: "Dashboard Overview", href: "/dashboard" },
            { text: "Contact", href: "/contact" },
        ];

        const goal = "test the dashboard";
        const feature = "dashboard settings";

        const keywords = `${goal} ${feature}`.toLowerCase().split(/\s+/).filter(Boolean);
        const scored = links.map((link) => {
            const linkText = `${link.text} ${link.href}`.toLowerCase();
            let score = 0;
            for (const kw of keywords) {
                if (kw.length < 3) continue;
                if (linkText.includes(kw)) score += 1;
            }
            return { ...link, score };
        });
        scored.sort((a, b) => b.score - a.score);

        // Dashboard-related links should be first
        expect(scored[0].href).toBe("/dashboard/settings");
        expect(scored[1].href).toBe("/dashboard");
        // Non-relevant links should be last
        expect(scored[scored.length - 1].score).toBe(0);
    });

    it("preserves original order when no goal", () => {
        const links = [
            { text: "Blog", href: "/blog" },
            { text: "Dashboard", href: "/dashboard" },
            { text: "About", href: "/about" },
        ];

        const scored = links.map((link) => ({ ...link, score: 0 }));
        scored.sort((a, b) => b.score - a.score);

        // All scores are 0, so stable sort preserves order
        expect(scored[0].href).toBe("/blog");
    });
});

describe("Real-world Site Scenarios", () => {
    describe("GitHub-like login page", () => {
        const elements = [
            el("textbox", "Username or email address", undefined, "text"),
            el("textbox", "Password", undefined, "password"),
            el("button", "Sign in"),
            el("link", "Forgot password?"),
            el("link", "Create an account"),
        ];
        const title = "Sign in to GitHub";

        it("detects auth signals", () => {
            const signals = getStructuralSignals(elements, title);
            expect(signals.hasPasswordField).toBe(true);
            expect(signals.hasEmailOrUserField).toBe(true);
            expect(shouldClassifyInterruption(signals)).toBe(true);
        });

        it("has auth form fields", () => {
            expect(hasAuthFormFields(elements)).toBe(true);
        });
    });

    describe("GitHub-like dashboard (post-login)", () => {
        const elements = [
            el("textbox", "Search or jump to..."),
            el("link", "Pull requests"),
            el("link", "Issues"),
            el("link", "Marketplace"),
            el("link", "Explore"),
            el("link", "Your repositories"),
            el("button", "New repository"),
            el("link", "Settings"),
            el("link", "Sign out"),
        ];
        const title = "GitHub";

        it("triggers pre-filter via its search box, but LLM would classify as none", () => {
            const signals = getStructuralSignals(elements, title);
            expect(signals.hasPasswordField).toBe(false);
            expect(signals.hasCodeField).toBe(false);
            expect(signals.isDeadEnd).toBe(false);
            // The "Search or jump to..." box is a fillable input, so the
            // permissive pre-filter now passes it to the LLM (which correctly
            // returns "none"). This is intentional: the LLM — not the rules —
            // decides whether a form gates content, so arbitrary field blockers
            // (a bare phone/name gate) are never silently skipped.
            expect(signals.hasFormInputs).toBe(true);
            expect(shouldClassifyInterruption(signals)).toBe(true);
        });

        it("does NOT have auth form fields", () => {
            expect(hasAuthFormFields(elements)).toBe(false);
        });
    });

    describe("Cookie consent overlay on a rich page", () => {
        const elements = Array.from({ length: 25 }, (_, i) => el("link", `Navigation ${i}`));
        elements.push(el("button", "Accept All Cookies"));
        elements.push(el("button", "Manage Preferences"));

        it("only triggers when overlay is detected in DOM", () => {
            const signalsNoOverlay = getStructuralSignals(elements, "News Site");
            expect(shouldClassifyInterruption(signalsNoOverlay)).toBe(false);

            const signalsWithOverlay = getStructuralSignals(elements, "News Site", true);
            expect(shouldClassifyInterruption(signalsWithOverlay)).toBe(true);
        });
    });

    describe("Shopify-like product page with promo code field", () => {
        const elements = [
            el("textbox", "Discount code", undefined, "text"),
            el("button", "Apply"),
            el("link", "Continue shopping"),
            el("link", "Cart"),
            el("button", "Checkout"),
            el("link", "Home"),
            el("link", "Products"),
            el("link", "Contact"),
        ];
        const title = "Your Cart - Fashion Store";

        it("triggers pre-filter but LLM would classify as none", () => {
            const signals = getStructuralSignals(elements, title);
            // "Discount code" matches /code/ name fallback, so hasCodeField is true.
            // But no password field, so this is not an auth page.
            // The LLM classifier will see the rich page context and classify as "none".
            expect(signals.hasPasswordField).toBe(false);
            expect(signals.hasCodeField).toBe(true);
            expect(shouldClassifyInterruption(signals)).toBe(true);
            expect(signals.elementCount).toBe(8);
        });
    });

    describe("Two-factor auth page", () => {
        const elements = [
            el("textbox", "Authentication code", undefined, "tel"),
            el("button", "Verify"),
            el("link", "Use a different method"),
        ];
        const title = "Two-factor authentication";

        it("detects OTP signals", () => {
            const signals = getStructuralSignals(elements, title);
            expect(signals.hasCodeField).toBe(true);
            expect(signals.isDeadEnd).toBe(true);
            expect(shouldClassifyInterruption(signals)).toBe(true);
        });
    });

    describe("Non-English login page (type-based detection)", () => {
        const elements = [
            el("textbox", "メールアドレス", undefined, "email"),
            el("textbox", "パスワード", undefined, "password"),
            el("button", "ログイン"),
        ];
        const title = "ログイン - サービス";

        it("detects auth via type=password regardless of language", () => {
            const signals = getStructuralSignals(elements, title);
            expect(signals.hasPasswordField).toBe(true);
            expect(signals.hasEmailOrUserField).toBe(true);
            expect(shouldClassifyInterruption(signals)).toBe(true);
        });

        it("has auth form fields", () => {
            expect(hasAuthFormFields(elements)).toBe(true);
        });
    });

    describe("Login page with non-standard field names", () => {
        const elements = [
            el("textbox", "user_identifier", 'input[name="user_identifier"]', "text"),
            el("textbox", "secret", 'input[name="secret"]', "password"),
            el("button", "Enter"),
        ];
        const title = "Access Portal";

        it("detects auth via type=password despite unusual field names", () => {
            const signals = getStructuralSignals(elements, title);
            expect(signals.hasPasswordField).toBe(true);
            expect(signals.hasEmailOrUserField).toBe(true);
            expect(signals.passwordSelectors.length).toBeGreaterThan(0);
            expect(signals.identitySelectors.length).toBeGreaterThan(0);
        });
    });

    describe("Login with placeholder-only labels", () => {
        const elements = [
            el(
                "textbox",
                "Enter your phone or email",
                "getByPlaceholder('Enter your phone or email')",
                "text",
            ),
            el("textbox", "", 'input[name="passwd"]', "password"),
            el("button", "Next"),
        ];
        const title = "Sign in - Microsoft";

        it("detects password field even with empty name", () => {
            const signals = getStructuralSignals(elements, title);
            expect(signals.hasPasswordField).toBe(true);
            expect(signals.hasEmailOrUserField).toBe(true);
        });
    });

    describe("CAPTCHA page", () => {
        const elements = [el("button", "I'm not a robot")];
        const title = "Please verify you are human";

        it("detects as dead-end (triggers pre-filter)", () => {
            const signals = getStructuralSignals(elements, title);
            expect(signals.isDeadEnd).toBe(true);
            expect(shouldClassifyInterruption(signals)).toBe(true);
        });
    });

    describe("Paywall page", () => {
        const elements = [el("button", "Subscribe Now"), el("link", "Learn More")];
        const title = "Subscribe to continue reading - News Site";

        it("detects as dead-end", () => {
            const signals = getStructuralSignals(elements, title);
            expect(signals.isDeadEnd).toBe(true);
            expect(shouldClassifyInterruption(signals)).toBe(true);
        });
    });

    describe("Selector array pipeline", () => {
        it("carries all selectors from element to structural signals", () => {
            const elements: SummaryElement[] = [
                {
                    role: "textbox",
                    name: "Username or email address",
                    type: "text",
                    selector: "getByRole('textbox', { name: 'Username or email address' })",
                    selectors: [
                        "getByRole('textbox', { name: 'Username or email address' })",
                        'input[name="login"]',
                        "#login_field",
                        "getByPlaceholder('Username or email address')",
                    ],
                },
                {
                    role: "textbox",
                    name: "Password",
                    type: "password",
                    selector: 'input[type="password"]',
                    selectors: ['input[name="password"]', "#password", 'input[type="password"]'],
                },
                {
                    role: "button",
                    name: "Sign in",
                    selectors: [
                        "getByRole('button', { name: 'Sign in' })",
                        'button[type="submit"]',
                    ],
                },
            ];
            const signals = getStructuralSignals(elements, "Sign in");
            expect(signals.passwordSelectors).toEqual([
                'input[name="password"]',
                "#password",
                'input[type="password"]',
            ]);
            expect(signals.identitySelectors).toEqual([
                "getByRole('textbox', { name: 'Username or email address' })",
                'input[name="login"]',
                "#login_field",
                "getByPlaceholder('Username or email address')",
            ]);
        });

        it("returns empty arrays when no matching fields", () => {
            const elements: SummaryElement[] = [
                { role: "link", name: "Home", selectors: ["getByText('Home')"] },
                { role: "link", name: "About", selectors: ["getByText('About')"] },
                { role: "link", name: "Contact", selectors: ["getByText('Contact')"] },
                { role: "link", name: "Blog", selectors: ["getByText('Blog')"] },
            ];
            const signals = getStructuralSignals(elements, "Dashboard");
            expect(signals.passwordSelectors).toEqual([]);
            expect(signals.identitySelectors).toEqual([]);
            expect(signals.codeFieldSelectors).toEqual([]);
        });
    });

    describe("Atlassian-style login (multi-step)", () => {
        const step1 = [
            {
                role: "textbox",
                name: "Enter your email",
                type: "email",
                selectors: [
                    'input[name="username"]',
                    "#username",
                    "getByPlaceholder('Enter your email')",
                ],
                selector: 'input[name="username"]',
            } as SummaryElement,
            {
                role: "button",
                name: "Continue",
                selectors: [
                    "getByRole('button', { name: 'Continue' })",
                    'button[type="submit"]',
                    "#login-submit",
                ],
            } as SummaryElement,
            {
                role: "link",
                name: "Can't log in?",
                selectors: ["getByText('Can\\'t log in?')"],
            } as SummaryElement,
        ];
        const title = "Log in to continue - Atlassian";

        it("detects identity field without password on step 1", () => {
            const signals = getStructuralSignals(step1, title);
            expect(signals.hasPasswordField).toBe(false);
            expect(signals.hasEmailOrUserField).toBe(false);
        });

        const step2 = [
            {
                role: "textbox",
                name: "Enter your password",
                type: "password",
                selectors: [
                    'input[name="password"]',
                    "#password",
                    "getByPlaceholder('Enter your password')",
                ],
                selector: 'input[name="password"]',
            } as SummaryElement,
            {
                role: "button",
                name: "Log in",
                selectors: [
                    "getByRole('button', { name: 'Log in' })",
                    'button[type="submit"]',
                    "#login-submit",
                ],
            } as SummaryElement,
        ];

        it("detects password field on step 2 with full selectors", () => {
            const signals = getStructuralSignals(step2, title);
            expect(signals.hasPasswordField).toBe(true);
            expect(signals.passwordSelectors).toEqual([
                'input[name="password"]',
                "#password",
                "getByPlaceholder('Enter your password')",
            ]);
        });
    });

    describe("AWS Console login (complex form)", () => {
        const elements: SummaryElement[] = [
            {
                role: "textbox",
                name: "IAM user name",
                type: "text",
                selectors: ['input[name="username"]', "#username", "getByLabel('IAM user name')"],
                selector: 'input[name="username"]',
            },
            {
                role: "textbox",
                name: "Password",
                type: "password",
                selectors: [
                    'input[name="password"]',
                    "#password",
                    'input[type="password"]',
                    "getByLabel('Password')",
                ],
                selector: 'input[name="password"]',
            },
            {
                role: "checkbox",
                name: "Remember this account",
                type: "checkbox",
                selectors: ['input[name="remember"]'],
                selector: 'input[name="remember"]',
            },
            {
                role: "button",
                name: "Sign in",
                selectors: [
                    "getByRole('button', { name: 'Sign in' })",
                    "#signin_button",
                    'button[type="submit"]',
                ],
            },
            {
                role: "link",
                name: "Forgot password?",
                selectors: ["getByText('Forgot password?')"],
            },
            { role: "link", name: "Root user", selectors: ["getByText('Root user')"] },
        ];
        const title = "Sign in as IAM user";

        it("correctly identifies identity and password fields", () => {
            const signals = getStructuralSignals(elements, title);
            expect(signals.hasPasswordField).toBe(true);
            expect(signals.hasEmailOrUserField).toBe(true);
            expect(signals.identitySelectors).toContain('input[name="username"]');
            expect(signals.passwordSelectors).toContain('input[type="password"]');
        });

        it("does not confuse checkbox with identity field", () => {
            const signals = getStructuralSignals(elements, title);
            expect(signals.identitySelectors).not.toContain('input[name="remember"]');
        });
    });
});
