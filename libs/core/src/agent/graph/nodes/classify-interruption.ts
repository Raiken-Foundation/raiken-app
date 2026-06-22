import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import type {
    Credentials,
    InterruptionInfo,
    InterruptionType,
    StructuralSignals,
    SummaryElement as SumEl,
    SummaryElement,
} from "../utils";

/**
 * Find the primary submit button for a login form, preferring specific
 * labels ("Sign in", "Log in") over generic ones ("Continue").
 * Excludes OAuth/SSO buttons ("Continue with Google", "Sign in with Apple").
 */
/**
 * Find the primary submit button and return ALL its DOM-derived selectors.
 * Prefers specific labels ("Sign in", "Log in") over generic ones.
 * Excludes OAuth/SSO buttons.
 */
function findSubmitButtonSelectors(elements: SumEl[]): string[] {
    const EXCLUDE_PATTERN = /\b(with|via|using)\s+\w+|passkey|biometric|fingerprint|face\s*id/i;
    const buttonEls = elements.filter(
        (el) => el.role === "button" && !EXCLUDE_PATTERN.test(el.name),
    );

    const priorities: RegExp[] = [
        /^(sign in|log in|login)$/i,
        /^submit$/i,
        /^(sign in|log in|login)\b/i,
        /^continue$/i,
    ];

    for (const pattern of priorities) {
        const match = buttonEls.find((el) => pattern.test(el.name.trim()));
        if (match && match.selectors.length > 0) return [...match.selectors];
    }

    const fallback = buttonEls.find((el) => /sign in|log in|login|submit/i.test(el.name));
    if (fallback && fallback.selectors.length > 0) return [...fallback.selectors];

    return [];
}

const interruptionSchema = z.object({
    type: z
        .enum(["auth", "otp", "captcha", "consent", "paywall", "error", "none"])
        .describe(
            "The type of blocker on this page, or 'none' if the page is not blocking the user",
        ),
    requiresUser: z
        .boolean()
        .describe(
            "Whether the user must take manual action to resolve this (true for captcha, most paywalls, missing credentials)",
        ),
    message: z.string().describe("A short, user-facing message explaining the blocker"),
    actionElementName: z
        .string()
        .nullable()
        .describe(
            "The exact name of a button or link the agent can click to dismiss the blocker (e.g. the consent accept button). null if no automatic action is possible",
        ),
});

type ClassificationResult = z.infer<typeof interruptionSchema>;

const SYSTEM_PROMPT = `Classify whether a web page has a blocker preventing free navigation.

Types:
- auth: login/registration form blocking site content.
- otp: 2FA / verification / security code challenge.
- captcha: CAPTCHA / reCAPTCHA / hCaptcha / human verification.
- consent: cookie/privacy/GDPR overlay requiring dismissal.
- paywall: subscription/payment wall blocking content (not a pricing page).
- error: 404/500/maintenance/access-denied with no navigation.
- none: normal page.

Classify as none when:
- Settings/profile page where users can change email/password.
- Promo/Discount/Coupon/Zip code input.
- Pricing page that shows options but doesn't block.
- Registration where signup is optional.
- Page with "error" in title but normal nav/content.
- Forms that are normal page functionality (checkout, search, contact).

For consent: if a dismiss button exists, set actionElementName to its exact label; else requiresUser=true.
For auth: requiresUser=true when credentials are needed but unavailable.`;

function buildUserPrompt(
    pageTitle: string,
    elements: SummaryElement[],
    signals: StructuralSignals,
): string {
    const elementList = elements
        .slice(0, 25)
        .map((el) => {
            const typeTag = el.type ? ` [type=${el.type}]` : "";
            return `- ${el.role}: "${el.name}"${typeTag}`;
        })
        .join("\n");

    const observations: string[] = [];
    if (signals.hasPasswordField) observations.push("Password input field detected");
    if (signals.hasEmailOrUserField) observations.push("Email or username input field detected");
    if (signals.hasCodeField) observations.push("Code/verification input field detected");
    if (signals.hasBlockingOverlay)
        observations.push(
            "A modal dialog or overlay is blocking the page (aria-modal or dialog element detected)",
        );
    if (signals.isDeadEnd)
        observations.push(`Dead-end page (only ${signals.elementCount} interactive elements)`);
    if (signals.elementCount > 10)
        observations.push(`Feature-rich page (${signals.elementCount} interactive elements)`);

    return `Page title: "${pageTitle}"

Interactive elements (${elements.length} total):
${elementList}${elements.length > 25 ? `\n... and ${elements.length - 25} more` : ""}

Structural observations:
${observations.length > 0 ? observations.join("\n") : "No notable structural signals"}`;
}

/**
 * Use the LLM to classify whether a page has a blocking interruption.
 * Only called when structural pre-filtering indicates something suspicious.
 */
export async function classifyInterruption(
    pageTitle: string,
    elements: SummaryElement[],
    signals: StructuralSignals,
    credentials: Credentials,
    model: ChatOpenAI,
): Promise<InterruptionInfo | null> {
    const userPrompt = buildUserPrompt(pageTitle, elements, signals);

    let result: ClassificationResult;
    try {
        const structured = model.withStructuredOutput(interruptionSchema, {
            name: "classify_page_blocker",
        });
        result = await structured.invoke([
            new SystemMessage(SYSTEM_PROMPT),
            new HumanMessage(userPrompt),
        ]);
    } catch {
        try {
            result = await fallbackClassify(model, userPrompt);
        } catch (fallbackError) {
            console.warn("⚠️ Interruption classification failed:", fallbackError);
            return null;
        }
    }

    if (result.type === "none") return null;

    const info: InterruptionInfo = {
        type: result.type as InterruptionType,
        message: result.message,
        requiresUser: result.requiresUser,
    };

    if (result.type === "auth") {
        const needsIdentity =
            !credentials.username && !credentials.email && !credentials.useDefaults;
        const needsPassword =
            signals.hasPasswordField && !credentials.password && !credentials.useDefaults;
        info.requiresUser = needsIdentity || needsPassword;
        info.message = info.requiresUser
            ? "This page requires authentication. You can provide credentials in the chat, e.g.:\n" +
              "  `email: you@example.com password: secret`\n" +
              "Or say `use default credentials` to try test defaults."
            : "Authentication detected. Attempting to log in automatically.";

        info.fieldSelectors = {
            username: signals.identitySelectors,
            email: signals.identitySelectors,
            password: signals.passwordSelectors,
            submit: findSubmitButtonSelectors(elements),
        };
    } else if (result.type === "otp") {
        info.requiresUser = !credentials.code;
        info.fieldSelectors = {
            code: signals.codeFieldSelectors,
            submit: findSubmitButtonSelectors(elements),
        };
    } else if (result.type === "consent" && result.actionElementName) {
        const match = elements.find(
            (el) => el.name.toLowerCase() === result.actionElementName!.toLowerCase(),
        );
        if (match && match.selectors.length > 0) {
            info.actionSelector = match.selectors[0];
            info.requiresUser = false;
        }
    }

    return info;
}

// =========================================================================
// LLM-based credential extraction
// =========================================================================

const credentialsSchema = z.object({
    username: z
        .string()
        .nullable()
        .describe("Username or login name provided by the user, null if not provided"),
    email: z
        .string()
        .nullable()
        .describe("Email address provided by the user, null if not provided"),
    password: z.string().nullable().describe("Password provided by the user, null if not provided"),
    code: z
        .string()
        .nullable()
        .describe("OTP, verification code, or security code (numeric), null if not provided"),
    useDefaults: z.boolean().describe("True if the user asked to use default/test credentials"),
});

/**
 * Extract login credentials from user messages using the LLM.
 * Handles natural language like "my login is me@example.com and the pass is secret123"
 * that rigid regex patterns would miss.
 */
export async function extractCredentialsWithLLM(
    userPrompt: string,
    conversationHistory: Array<{ role: string; content: string }>,
    model: ChatOpenAI,
): Promise<Credentials> {
    const recentMessages = conversationHistory
        .slice(-6)
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n");

    const prompt = `Extract login credentials the user explicitly provided. Do not invent values.

Recent conversation:
${recentMessages}

Current message: ${userPrompt}

If the user said "use default/test credentials" or similar → useDefaults=true.
If nothing was provided → all fields null, useDefaults=false.`;

    try {
        const structured = model.withStructuredOutput(credentialsSchema, {
            name: "extract_credentials",
        });
        const result = await structured.invoke([
            new SystemMessage(prompt),
            new HumanMessage(userPrompt),
        ]);

        return {
            username: result.username || undefined,
            email: result.email || undefined,
            password: result.password || undefined,
            code: result.code || undefined,
            useDefaults: result.useDefaults,
        };
    } catch {
        return {
            username: undefined,
            email: undefined,
            password: undefined,
            code: undefined,
            useDefaults: false,
        };
    }
}

// =========================================================================
// Fallback classification
// =========================================================================

async function fallbackClassify(
    model: ChatOpenAI,
    userPrompt: string,
): Promise<ClassificationResult> {
    const strictPrompt = `${SYSTEM_PROMPT}\n\nReturn JSON only, no fences:\n{"type":"auth|otp|captcha|consent|paywall|error|none","requiresUser":boolean,"message":string,"actionElementName":string|null}`;

    const response = await model.invoke([
        new SystemMessage(strictPrompt),
        new HumanMessage(userPrompt),
    ]);

    const content = Array.isArray(response.content)
        ? response.content
              .map((part) => (typeof part === "string" ? part : part?.text || ""))
              .join("")
        : response.content;

    if (!content || typeof content !== "string") {
        throw new Error("Classifier returned empty output.");
    }

    let cleaned = content.trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenceMatch?.[1]) {
        cleaned = fenceMatch[1].trim();
    }
    const jsonStart = cleaned.indexOf("{");
    const jsonEnd = cleaned.lastIndexOf("}");
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
    }

    const parsed = JSON.parse(cleaned);
    return interruptionSchema.parse({
        type: parsed.type,
        requiresUser: parsed.requiresUser ?? true,
        message: parsed.message ?? "A blocker was detected.",
        actionElementName: parsed.actionElementName ?? null,
    });
}
