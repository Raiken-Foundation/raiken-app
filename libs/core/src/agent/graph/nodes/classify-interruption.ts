import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { LLM_REQUEST_TIMEOUT_MS } from "../../ai-providers";
import {
    getRequestedInputFields,
    type InterruptionInfo,
    type InterruptionType,
    type RequestedField,
    type StructuralSignals,
    type SummaryElement as SumEl,
    type SummaryElement,
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
export function findSubmitButtonSelectors(elements: SumEl[]): string[] {
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
    userPrompt: string,
    conversationHistory: Array<{ role: string; content: string }>,
    model: BaseChatModel,
    // True when the current `userPrompt` is the user's reply to a prior
    // credential/field request (i.e. we're resuming a blocker), so a bare value
    // should be accepted for a single-field form. False during initial page
    // detection, where `userPrompt` is the original goal.
    isReply = false,
): Promise<InterruptionInfo | null> {
    const classificationPrompt = buildUserPrompt(pageTitle, elements, signals);

    let result: ClassificationResult;
    try {
        const structured = model.withStructuredOutput(interruptionSchema, {
            name: "classify_page_blocker",
        });
        result = await structured.invoke(
            [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(classificationPrompt)],
            { timeout: LLM_REQUEST_TIMEOUT_MS },
        );
    } catch {
        try {
            result = await fallbackClassify(model, classificationPrompt);
        } catch (fallbackError) {
            console.warn("Interruption classification failed:", fallbackError);
            return null;
        }
    }

    if (result.type === "none") return null;

    const info: InterruptionInfo = {
        type: result.type as InterruptionType,
        message: result.message,
        requiresUser: result.requiresUser,
    };

    if (result.type === "auth" || result.type === "otp") {
        // Enumerate the actual fields the page is asking for and figure out
        // whether the user has already supplied everything needed. The field
        // names are unknown until we inspect the DOM, so we never assume
        // email/password — we ask for (and fill) whatever the page presents.
        const requestedFields = getRequestedInputFields(elements);
        info.requestedFields = requestedFields;
        info.submitSelectors = findSubmitButtonSelectors(elements);

        const mapped = await mapValuesToFields(
            requestedFields,
            userPrompt,
            conversationHistory,
            model,
            { isReply },
        );
        const unmet = requestedFields.filter((f) => !mapped.values[f.key]);
        info.requiresUser = requestedFields.length === 0 || unmet.length > 0;
        info.message = info.requiresUser
            ? buildFieldRequestMessage(requestedFields)
            : "Credentials detected. Attempting to continue automatically.";
    } else if (result.type === "consent" && result.actionElementName) {
        const actionElementName = result.actionElementName;
        const match = elements.find(
            (el) => el.name.toLowerCase() === actionElementName.toLowerCase(),
        );
        if (match && match.selectors.length > 0) {
            info.actionSelector = match.selectors[0];
            info.requiresUser = false;
        }
    }

    return info;
}

// =========================================================================
// DOM-driven credential/value mapping
// =========================================================================

/**
 * Build the user-facing prompt naming the exact fields the page is asking for,
 * so the user knows what to send back — whether that's an email, a PIN, an
 * employee number, a one-off code, or several fields at once.
 */
export function buildFieldRequestMessage(requestedFields: RequestedField[]): string {
    if (requestedFields.length === 0) {
        return (
            "This page needs input to continue, but I couldn't detect the specific fields. " +
            "Please complete it manually in the browser, then say 'continue'."
        );
    }
    const labels = requestedFields.map((f) => f.label).join(", ");
    const example = requestedFields.map((f) => `${f.label}: <value>`).join(", ");
    return `This page is asking for: ${labels}. Provide the value(s) in the chat, e.g. \`${example}\`.`;
}

/**
 * Use the LLM to map the user's free-text reply onto the specific fields the
 * page is requesting. The schema is built dynamically from the DOM-derived
 * fields, so this recognises arbitrary credentials (a code, a number, an
 * employee id) — not just email/password. Fails open (empty map) on error.
 */
export async function mapValuesToFields(
    requestedFields: RequestedField[],
    userPrompt: string,
    conversationHistory: Array<{ role: string; content: string }>,
    model: BaseChatModel,
    options: { isReply?: boolean } = {},
): Promise<{ values: Record<string, string> }> {
    const recentMessages = conversationHistory
        .slice(-6)
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n");

    const shape: Record<string, z.ZodTypeAny> = {};
    for (const field of requestedFields) {
        const typeHint = field.type ? ` (input type: ${field.type})` : "";
        // Accept string OR number: models routinely return a bare number for a
        // numeric-looking value (phone, PIN, code). If we constrained this to
        // z.string() the structured-output parse would throw on the number and
        // we'd drop the value entirely — the exact cause of the "I gave it my
        // phone number but it keeps asking" loop.
        shape[field.key] = z
            .union([z.string(), z.number()])
            .nullable()
            .describe(
                `The value the user provided for the field labelled "${field.label}"${typeHint}, or null if the user did not provide it`,
            );
    }
    const schema = z.object(shape);

    const fieldList =
        requestedFields.length > 0
            ? requestedFields
                  .map(
                      (f) =>
                          `- key "${f.key}": labelled "${f.label}"${f.type ? ` (type ${f.type})` : ""}`,
                  )
                  .join("\n")
            : "(no specific fields detected)";

    const prompt = `A web page is blocking the user and asking for the following input fields:
${fieldList}

Match the value(s) the user provided to the correct field by its label, type, and context.
Do not invent values — only fill a field if the user clearly supplied that value.
A bare value on its own (e.g. just a phone number, code, or name) is a valid answer to
the single field being asked for — return it as a string.

Recent conversation:
${recentMessages}

Current message: ${userPrompt}`;

    const values: Record<string, string> = {};
    try {
        const structured = model.withStructuredOutput(schema, { name: "map_values_to_fields" });
        const result = (await structured.invoke(
            [new SystemMessage(prompt), new HumanMessage(userPrompt)],
            { timeout: LLM_REQUEST_TIMEOUT_MS },
        )) as Record<string, unknown>;

        for (const field of requestedFields) {
            const v = result[field.key];
            // Coerce numbers to strings; a numeric answer is still a valid value.
            if (v !== null && v !== undefined && String(v).trim().length > 0) {
                values[field.key] = String(v).trim();
            }
        }
    } catch {
        // Structured output failed entirely — fall through to the deterministic
        // single-field fallback below rather than giving up.
    }

    // Deterministic fallback for the overwhelmingly common case: the page asks
    // for exactly ONE field and the user replies with exactly one value. This
    // must not fire during initial page detection (where `userPrompt` is the
    // original goal like "go through the app"), so it is gated on `isReply` —
    // true only when the agent is resuming after asking the user for input.
    if (options.isReply && requestedFields.length === 1) {
        const only = requestedFields[0];
        if (!values[only.key]) {
            const direct = extractSingleReplyValue(userPrompt, only.type);
            if (direct) values[only.key] = direct;
        }
    }

    return { values };
}

/**
 * Pull a single field value out of a user's reply. Handles a bare value
 * ("679630188"), a "Label: value" form ("Phone: 679630188"), and strips
 * formatting from numeric fields. Only used as a last-resort fallback when the
 * user is clearly replying to a single-field request.
 */
function extractSingleReplyValue(userPrompt: string, fieldType?: string): string | null {
    let candidate = userPrompt.trim();
    if (!candidate) return null;

    // "Label: value" → take what's after the first colon (if it's near the start).
    const colonIdx = candidate.indexOf(":");
    if (colonIdx !== -1 && colonIdx <= 40) {
        const afterColon = candidate.slice(colonIdx + 1).trim();
        if (afterColon) candidate = afterColon;
    }

    // Single line only — ignore any trailing prose. `split` always returns at
    // least one element, so the `?? ""` fallback is unreachable in practice.
    candidate = (candidate.split(/\r?\n/)[0] ?? "").trim();
    if (!candidate) return null;

    // For numeric-style inputs, keep only digits (preserving a leading +) so
    // stray words or spaces around the number don't get typed into the field.
    if (fieldType === "tel" || fieldType === "number") {
        const digits = candidate.replace(/[^\d]/g, "");
        if (digits.length >= 3) {
            return candidate.startsWith("+") ? `+${digits}` : digits;
        }
    }

    return candidate;
}

// =========================================================================
// Fallback classification
// =========================================================================

async function fallbackClassify(
    model: BaseChatModel,
    userPrompt: string,
): Promise<ClassificationResult> {
    const strictPrompt = `${SYSTEM_PROMPT}\n\nReturn JSON only, no fences:\n{"type":"auth|otp|captcha|consent|paywall|error|none","requiresUser":boolean,"message":string,"actionElementName":string|null}`;

    const response = await model.invoke(
        [new SystemMessage(strictPrompt), new HumanMessage(userPrompt)],
        { timeout: LLM_REQUEST_TIMEOUT_MS },
    );

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
