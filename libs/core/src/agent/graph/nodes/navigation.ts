import * as fsSync from "node:fs";
import * as path from "node:path";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { BrowserSession } from "../../../browser/session";
import { LLM_REQUEST_TIMEOUT_MS } from "../../ai-providers";
import type { GraphStateType } from "../state";
import type { ActionResult, InterruptionInfo, SummaryElement } from "../utils";
import {
    expandActionSynonyms,
    extractPageTitle,
    extractUrlFromText,
    getStructuralSignals,
    goalTargetsUnauthedPage,
    matchesAction,
    normalizeExploreUrl,
    parseSummaryElements,
    shouldClassifyInterruption,
} from "../utils";
import { getAppOrigin, isAuthHost, resolveEntryUrl } from "./auth-entry";
import { classifyInterruption } from "./classify-interruption";
import type { AgentNodeDeps, CallTool } from "./types";

function loadExploreMaxPages(projectPath: string): number {
    try {
        const raw = fsSync.readFileSync(path.join(projectPath, "raiken.config.json"), "utf-8");
        const config = JSON.parse(raw) as { discovery?: { maxPages?: number } };
        const val = config.discovery?.maxPages;
        if (typeof val === "number" && val > 0) return val;
    } catch {
        // Config missing or invalid
    }
    return 20;
}

// Exploration stops on its own before hitting `maxPages`: the model is asked
// whether it has seen enough (every N pages), and a novelty guard bails out
// when several consecutive pages surface no new links.
const SUFFICIENCY_MIN_PAGES = 3;
const SUFFICIENCY_CHECK_INTERVAL = 3;
const MAX_UNPRODUCTIVE_STREAK = 3;

const sufficiencySchema = z.object({
    sufficient: z
        .boolean()
        .describe(
            "True if the pages visited so far already cover the user's goal, or if continuing to crawl is unlikely to reveal new relevant functionality",
        ),
    reason: z.string().describe("A short reason for the decision"),
});

/**
 * Ask the model whether exploration has gathered enough to satisfy the goal.
 * Keeps the prompt cheap by passing only page titles. Fails open (returns
 * false) so a model error never prematurely stops exploration.
 */
async function assessExplorationSufficiency(
    model: BaseChatModel,
    goalText: string,
    pageSummaries: string[],
): Promise<boolean> {
    if (pageSummaries.length === 0) return false;
    try {
        const pages = pageSummaries
            .map((s, i) => `${i + 1}. ${extractPageTitle(s) || "(untitled page)"}`)
            .join("\n");
        const structured = model.withStructuredOutput(sufficiencySchema, {
            name: "assess_exploration_sufficiency",
        });
        const result = await structured.invoke(
            [
                new SystemMessage(
                    "You decide whether an automated web crawler has explored enough of a site to satisfy the user's goal. " +
                        "Answer sufficient=true when the visited pages already cover the goal, or when continuing is unlikely to reveal new relevant functionality. " +
                        "Prefer stopping early over exhaustive crawling.",
                ),
                new HumanMessage(
                    `Goal: ${goalText || "(general exploration)"}\n\nPages visited so far (${pageSummaries.length}):\n${pages}`,
                ),
            ],
            { timeout: LLM_REQUEST_TIMEOUT_MS },
        );
        return result.sufficient === true;
    } catch {
        return false;
    }
}

async function checkForInterruption(
    summary: string | null,
    userPrompt: string,
    conversationHistory: Array<{ role: string; content: string }>,
    model: BaseChatModel,
    projectPath: string,
): Promise<InterruptionInfo | null> {
    if (!summary) return null;
    const elements = parseSummaryElements(summary);
    const pageTitle = extractPageTitle(summary);

    let hasOverlay = false;
    try {
        const session = BrowserSession.getInstance(projectPath);
        hasOverlay = await session.hasBlockingOverlay();
    } catch {
        /* browser not active */
    }

    const signals = getStructuralSignals(elements, pageTitle, hasOverlay);
    if (!shouldClassifyInterruption(signals)) return null;
    return classifyInterruption(
        pageTitle,
        elements,
        signals,
        userPrompt,
        conversationHistory,
        model,
    );
}

export const createNavigateNode =
    ({ callTool, projectPath, onProgress }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        const historyText = state.conversationHistory.map((msg) => msg.content).join("\n");

        let rememberedUrl: string | null = null;
        try {
            const { AgentMemory } = await import("../../memory");
            const memory = AgentMemory.getInstance(projectPath);
            rememberedUrl = memory.getPreference("project_base_url") || null;
        } catch {
            /* memory not available */
        }

        // Never trust a `project_base_url` that points at an identity provider: a
        // past login redirect can poison it with the IdP origin (e.g.
        // accounts.example.com), which would send every run to the login wall.
        if (rememberedUrl) {
            try {
                if (isAuthHost(new URL(rememberedUrl).hostname)) rememberedUrl = null;
            } catch {
                rememberedUrl = null;
            }
        }

        // The app's real origin, inferred from discovery — the reliable base for
        // resolving relative targets even when project_base_url was poisoned.
        let appOrigin: string | null = rememberedUrl;
        try {
            appOrigin = rememberedUrl ?? (await getAppOrigin(projectPath));
        } catch {
            /* discovery unavailable — appOrigin stays as rememberedUrl (or null) */
        }

        const extractedUrl = extractUrlFromText(`${historyText}\n${state.userPrompt}`);
        let url = state.targetUrl || extractedUrl || rememberedUrl || appOrigin;

        // Resolve a relative / bare-path target ("/", "/overview") to an absolute
        // URL against the app origin. Playwright's page.goto rejects relative URLs
        // ("Cannot navigate to invalid URL"), so this must happen before we drive
        // the browser — and it must resolve against the app, not a poisoned base.
        if (url && !/^https?:\/\//i.test(url) && appOrigin) {
            try {
                url = new URL(url, appOrigin).toString();
            } catch {
                /* leave url as-is; the navigation guard below will handle failure */
            }
        }

        // Smart authenticated entry: the bare origin ("/") is often a login/landing
        // wall that redirects to SSO even for an authenticated session, while deep
        // routes complete SSO silently. When we have a reusable session and known
        // content routes, enter there instead of capturing the login page. Only
        // applies to inferred entry (remembered origin) — an explicit user URL is
        // always respected.
        if (url) {
            const explicitTarget = !!(state.targetUrl || extractedUrl);
            try {
                url = await resolveEntryUrl(projectPath, url, explicitTarget);
            } catch {
                /* fall back to the original URL */
            }
        }

        // If no URL was supplied but a browser session is already on a page
        // (e.g. the user just asked to "sign out" mid-session), reuse that live
        // page instead of failing — the action lives on the current page, not a
        // fresh navigation target.
        if (!url) {
            try {
                const session = BrowserSession.getInstance(projectPath);
                if (session.isActive()) {
                    const current = session.getCurrentUrl();
                    if (current && current !== "about:blank") {
                        url = current;
                    }
                }
            } catch {
                /* no live session */
            }
        }

        if (!url) {
            // No URL and grounding was only an optimization → generate from code.
            if (state.groundingOptional) {
                return { currentUrl: null, domSummary: null, groundingFailed: true };
            }
            return {
                currentUrl: "",
                domSummary: null,
                pagesVisited: [],
                pageSummaries: [],
                awaitUserMessage:
                    "I need a URL to navigate to. Please provide the base URL of your application.",
                shouldPause: true,
            };
        }

        onProgress?.("Navigating", url);
        const navResult = await callTool("navigateTo", { url });

        if (!navResult.success) {
            // Optional grounding (inferred base URL) failed → don't block the
            // user; fall back to code-only test generation.
            if (state.groundingOptional) {
                return { currentUrl: null, domSummary: null, groundingFailed: true };
            }
            // A hard navigation failure (DNS, connection refused, timeout) means
            // there's no usable page to explore. Pause and tell the user instead
            // of crawling a broken/blank page and polluting exploration memory
            // with a URL that never loaded. Note: we do NOT store the error as
            // domSummary — the generate gate must never mistake an error string
            // for real DOM.
            return {
                currentUrl: url,
                domSummary: null,
                pagesVisited: [],
                pageSummaries: [],
                shouldPause: true,
                awaitUserMessage: `I couldn't load ${url} (${navResult.message || "unknown error"}). Please check the URL and that your app is running, then try again.`,
            };
        }

        const summary =
            (navResult.data as { summary?: string; url?: string } | undefined)?.summary || null;
        const currentUrl = (navResult.data as { url?: string } | undefined)?.url || url;

        try {
            const { AgentMemory } = await import("../../memory");
            const memory = AgentMemory.getInstance(projectPath);
            const parsed = new URL(currentUrl);
            const origin = parsed.origin;
            // Never record the identity-provider origin as the app's base URL. A
            // login redirect can land the browser on accounts.example.com; storing
            // that would send every future run straight to the login wall (and
            // hide the real app's discovered routes behind an origin mismatch).
            if (origin && origin !== "null" && !isAuthHost(parsed.hostname)) {
                memory.setPreference("project_base_url", origin);
            }
        } catch {
            /* non-critical */
        }

        return {
            currentUrl,
            domSummary: summary,
            pagesVisited: [currentUrl],
            pageSummaries: summary ? [summary] : [],
        };
    };

/**
 * Score a link's relevance to the user's goal so the explore loop
 * prioritizes pages that matter (e.g., "dashboard" when the user
 * wants to test the dashboard) over unrelated pages (e.g., "/blog").
 */
// Soft hint used only to order exploration, never to skip. If the current goal
// is itself about auth, matching links score UP via keywords below and this
// penalty is intentionally suppressed.
const AUTH_HINT =
    /\b(login|log-in|signin|sign-in|sign_in|signup|sign-up|sign_up|register|auth|sso|oauth|forgot[-_]?password|reset[-_]?password)\b/i;

function scoreLinkRelevance(
    link: { text: string; href: string },
    goal: string | null,
    feature: string | null,
    action?: string | null,
): number {
    const combined = `${goal || ""} ${feature || ""}`.toLowerCase();
    const linkText = `${link.text} ${link.href}`.toLowerCase();

    let score = 0;
    for (const kw of combined.split(/\s+/)) {
        if (kw.length < 3) continue;
        if (linkText.includes(kw)) score += 1;
    }

    // When hunting for a specific action, strongly prefer links that either
    // name the action directly or lead to pages that usually host it (account,
    // profile, settings, menu). This is the "check every link to find where the
    // action likely lives" behavior a person uses.
    if (action) {
        if (matchesAction(link.text, action) || matchesAction(link.href, action)) {
            score += 5;
        } else if (MENU_HINT.test(linkText)) {
            score += 2;
        }
    }

    // De-prioritize (but never exclude) auth-shaped links unless the goal is
    // about auth. This keeps exploration focused on primary content first while
    // still eventually visiting auth pages so the agent tests what's there.
    if (AUTH_HINT.test(linkText) && !AUTH_HINT.test(combined)) {
        score -= 0.5;
    }

    return score;
}

function sortLinksByRelevance(
    links: Array<{ text: string; href: string }>,
    goal: string | null,
    feature: string | null,
    action?: string | null,
): Array<{ text: string; href: string }> {
    return [...links].sort(
        (a, b) =>
            scoreLinkRelevance(b, goal, feature, action) -
            scoreLinkRelevance(a, goal, feature, action),
    );
}

// Controls that typically hide destructive/account actions (sign out, delete
// account, …) behind a click. A human opens these first when hunting for such
// actions, so the agent does too.
const MENU_HINT =
    /\b(menu|account|profile|avatar|user|settings|options|more|hamburger|dropdown|nav)\b/i;

const CLICKABLE_ROLES = new Set(["button", "link", "menuitem", "tab", "option", "checkbox"]);

/**
 * Find the single element on a page whose visible name best matches the target
 * action, preferring genuinely clickable roles (button/link/menuitem) so we
 * don't click a heading that merely contains the word.
 */
function findActionElement(elements: SummaryElement[], action: string): SummaryElement | null {
    let fallback: SummaryElement | null = null;
    for (const el of elements) {
        if (!matchesAction(el.name, action)) continue;
        if (CLICKABLE_ROLES.has(el.role.toLowerCase())) return el;
        if (!fallback) fallback = el;
    }
    return fallback;
}

/** Candidate menu/account triggers to open when the action isn't directly visible. */
function findMenuOpeners(elements: SummaryElement[], action: string): SummaryElement[] {
    const synonyms = expandActionSynonyms(action);
    return elements.filter((el) => {
        const role = el.role.toLowerCase();
        if (!CLICKABLE_ROLES.has(role) && role !== "img" && role !== "image") return false;
        const name = el.name.toLowerCase();
        // Don't re-open something that already *is* the action.
        if (synonyms.some((s) => name.includes(s))) return false;
        return MENU_HINT.test(name);
    });
}

function selectorFor(el: SummaryElement): string | string[] | null {
    if (el.selectors && el.selectors.length > 0) return el.selectors;
    if (el.selector) return el.selector;
    return null;
}

function firstSelector(sel: string | string[] | null): string | null {
    if (!sel) return null;
    return Array.isArray(sel) ? (sel[0] ?? null) : sel;
}

/**
 * Try to locate (and, when requested, perform) the target action on the
 * current page. If it isn't directly visible, open likely account/menu
 * triggers and re-scan — mirroring how a person hunts for "Sign out".
 * Returns an ActionResult only when a matching control is found.
 */
async function attemptActionOnCurrentPage(
    callTool: CallTool,
    action: string,
    performAction: boolean,
    pageUrl: string | null,
    summary: string,
): Promise<ActionResult | null> {
    const elements = parseSummaryElements(summary);
    let match = findActionElement(elements, action);
    let note = "found directly on page";

    if (!match) {
        for (const opener of findMenuOpeners(elements, action).slice(0, 3)) {
            const openerSel = selectorFor(opener);
            if (!openerSel) continue;
            const opened = await callTool("clickElement", { selector: openerSel });
            if (!opened.success) continue;
            const recap = await callTool("captureCurrentPage", {});
            const recapSummary = (recap.data as { summary?: string } | undefined)?.summary || null;
            if (!recapSummary) continue;
            const reMatch = findActionElement(parseSummaryElements(recapSummary), action);
            if (reMatch) {
                match = reMatch;
                note = `opened "${opener.name}" -> found "${reMatch.name}"`;
                break;
            }
        }
    }

    if (!match) return null;

    const sel = selectorFor(match);
    const selectorStr = firstSelector(sel);

    if (!performAction) {
        return {
            action,
            found: true,
            performed: false,
            page: pageUrl,
            selector: selectorStr,
            note,
        };
    }

    if (!sel) {
        return {
            action,
            found: true,
            performed: false,
            page: pageUrl,
            selector: null,
            note: `${note}; no usable selector to click`,
        };
    }

    const clicked = await callTool("clickElement", { selector: sel });
    return {
        action,
        found: true,
        performed: clicked.success,
        page: pageUrl,
        selector: selectorStr,
        note: clicked.success
            ? `${note}; clicked "${match.name}"`
            : `${note}; click failed: ${clicked.message}`,
    };
}

export const createExploreNode =
    ({ callTool, projectPath, model, onProgress, signal }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        // When the goal is to test the unauthenticated / login page itself, the
        // entry page IS the target — don't crawl. Crawling from a login wall only
        // wanders into the identity provider (registration/authenticate routes),
        // re-triggering the auth interruption and never reaching test generation.
        // Pass the captured entry page straight through to the generate step.
        if (goalTargetsUnauthedPage(state.userPrompt) && state.domSummary) {
            return {
                pagesVisited: state.currentUrl ? [state.currentUrl] : [],
                pageSummaries: [state.domSummary],
                domSummary: state.domSummary,
                currentUrl: state.currentUrl ?? null,
            };
        }

        const maxPages = state.maxExplorePages ?? loadExploreMaxPages(projectPath);
        // Visited set is keyed on normalized URLs so /settings, /settings/, and
        // /settings#top count once — this is what stops the "cycling between the
        // same 3 pages" feel.
        const visited = new Set((state.pagesVisited || []).map(normalizeExploreUrl));
        const summaries: string[] = [];
        const newVisited: string[] = [];
        let lastSummary: string | null = state.domSummary || null;
        let lastUrl: string | null = state.currentUrl || null;
        let pagesExplored = 0;

        const goal = state.activeGoal || null;
        const feature = state.targetFeature || null;
        const action = state.targetAction || null;
        const performAction = state.performAction === true;
        const goalText =
            [goal, feature, action ? `perform: ${action}` : null].filter(Boolean).join(" - ") ||
            state.userPrompt ||
            "";
        let unproductiveStreak = 0;
        let actionResult: ActionResult | null = null;

        // Wall-clock budget for exploration. The action-hunt path deliberately
        // disables the novelty/sufficiency early-exits (it must keep looking for
        // the requested interaction), which on a slow app can consume the ENTIRE
        // run before test generation ever executes — leaving the page with no
        // test at all. This hard ceiling guarantees we always yield control back
        // to generation with whatever we've gathered.
        const exploreStart = Date.now();
        const exploreBudgetMs = state.exploreBudgetMs ?? 120_000;

        // Persist a found action path so future runs (and test generation) know
        // exactly where/how to reach it without re-crawling.
        const persistActionPath = async (result: ActionResult): Promise<void> => {
            if (!result.found) return;
            try {
                const { AgentMemory } = await import("../../memory");
                const memory = AgentMemory.getInstance(projectPath);
                memory.setPreference(
                    `action_path:${result.action.toLowerCase().trim()}`,
                    JSON.stringify({
                        page: result.page,
                        selector: result.selector,
                        note: result.note,
                        performed: result.performed,
                        at: Date.now(),
                    }),
                );
            } catch {
                /* memory not available — non-critical */
            }
        };

        // Goal-directed action hunt on the entry page BEFORE crawling links.
        if (action && lastSummary) {
            actionResult = await attemptActionOnCurrentPage(
                callTool,
                action,
                performAction,
                lastUrl,
                lastSummary,
            );
            if (actionResult && (actionResult.performed || !performAction)) {
                await persistActionPath(actionResult);
                // Re-capture so downstream context sees the post-action page.
                if (performAction && actionResult.performed) {
                    const recap = await callTool("captureCurrentPage", {});
                    const recapData = recap.data as { summary?: string; url?: string } | undefined;
                    if (recapData?.summary) {
                        lastSummary = recapData.summary;
                        summaries.push(recapData.summary);
                        lastUrl = recapData.url || lastUrl;
                    }
                }
                return {
                    pagesVisited: newVisited,
                    pageSummaries: summaries,
                    domSummary: lastSummary,
                    currentUrl: lastUrl,
                    actionResult,
                };
            }
        }

        let linksToProcess: Array<{ text: string; href: string }> = [];

        // Determine the base origin to avoid following cross-origin links
        const startUrl = state.currentUrl || state.targetUrl || "";
        let baseOrigin: string | null = null;
        try {
            baseOrigin = new URL(startUrl).origin;
        } catch {
            /* no valid start URL */
        }

        const isSameOrigin = (href: string): boolean => {
            if (!baseOrigin) return true;
            try {
                return new URL(href).origin === baseOrigin;
            } catch {
                return false;
            }
        };

        // We deliberately do NOT hard-skip links by URL shape. A path that
        // "looks like" auth (/login, /auth, …) may be a normal feature in this
        // particular app, and skipping it would mean never testing what's there.
        // Instead we explore same-origin links and let the DOM-driven
        // interruption detector decide what is actually an auth wall. Auth-shaped
        // links are only softly de-prioritized (explored last) — see
        // scoreLinkRelevance — so main content is covered first.
        const isExplorableLink = (href: string): boolean => isSameOrigin(href);

        const discoverResult = await callTool("discoverLinks", { includeExternal: false });
        if (discoverResult.success) {
            const initialLinks =
                (
                    discoverResult.data as
                        | { links?: Array<{ text: string; href: string }> }
                        | undefined
                )?.links || [];
            linksToProcess = sortLinksByRelevance(
                initialLinks.filter(
                    (link) =>
                        !visited.has(normalizeExploreUrl(link.href)) && isExplorableLink(link.href),
                ),
                goal,
                feature,
                action,
            );
        }

        while (linksToProcess.length > 0 && pagesExplored < maxPages) {
            // Abort promptly mid-crawl instead of finishing every remaining page.
            if (signal?.aborted) break;

            // Time budget reached: stop exploring so generation still runs. This
            // fires even during an action hunt (which otherwise never self-limits).
            if (Date.now() - exploreStart > exploreBudgetMs) {
                onProgress?.("Exploring", `time budget reached after ${pagesExplored} page(s)`);
                break;
            }

            const link = linksToProcess.shift();
            if (!link) break; // unreachable — the `while` condition above guarantees a queued link
            if (visited.has(normalizeExploreUrl(link.href))) continue;

            onProgress?.("Exploring", `${pagesExplored + 1}/${maxPages}`);
            const nav = await callTool("navigateTo", { url: link.href });
            if (!nav.success) {
                visited.add(normalizeExploreUrl(link.href));
                continue;
            }

            const summary =
                (nav.data as { summary?: string; url?: string } | undefined)?.summary || null;
            const url = (nav.data as { url?: string } | undefined)?.url || link.href;
            visited.add(normalizeExploreUrl(url));
            newVisited.push(url);
            pagesExplored++;

            if (summary) {
                summaries.push(summary);
                lastSummary = summary;
            }
            lastUrl = url;

            // Goal-directed action hunt on this page (incl. opening menus).
            if (action && summary) {
                const found = await attemptActionOnCurrentPage(
                    callTool,
                    action,
                    performAction,
                    url,
                    summary,
                );
                if (found && (found.performed || !performAction)) {
                    actionResult = found;
                    await persistActionPath(found);
                    if (performAction && found.performed) {
                        const recap = await callTool("captureCurrentPage", {});
                        const recapData = recap.data as
                            | { summary?: string; url?: string }
                            | undefined;
                        if (recapData?.summary) {
                            lastSummary = recapData.summary;
                            summaries.push(recapData.summary);
                            lastUrl = recapData.url || url;
                        }
                    }
                    // Goal met — stop crawling.
                    break;
                }
                if (found) actionResult = found;
            }

            const interruption = await checkForInterruption(
                summary,
                state.userPrompt,
                state.conversationHistory,
                model,
                projectPath,
            );
            if (interruption) {
                return {
                    pagesVisited: newVisited,
                    pageSummaries: summaries,
                    domSummary: lastSummary,
                    currentUrl: lastUrl,
                    interruption,
                    actionResult,
                };
            }

            let freshCount = 0;
            const moreLinks = await callTool("discoverLinks", { includeExternal: false });
            if (moreLinks.success) {
                const newLinks =
                    (
                        moreLinks.data as
                            | { links?: Array<{ text: string; href: string }> }
                            | undefined
                    )?.links || [];
                const fresh = newLinks.filter(
                    (nl) =>
                        !visited.has(normalizeExploreUrl(nl.href)) &&
                        isExplorableLink(nl.href) &&
                        !linksToProcess.some(
                            (l) => normalizeExploreUrl(l.href) === normalizeExploreUrl(nl.href),
                        ),
                );
                freshCount = fresh.length;
                linksToProcess.push(...fresh);
                linksToProcess = sortLinksByRelevance(linksToProcess, goal, feature, action);
            }

            // Novelty guard: if several consecutive pages surface no new links,
            // we've likely seen everything reachable — stop instead of churning.
            // When actively hunting for an action, keep going (don't bail early)
            // until every discovered link is checked or maxPages is hit.
            unproductiveStreak = freshCount === 0 ? unproductiveStreak + 1 : 0;
            if (!action && unproductiveStreak >= MAX_UNPRODUCTIVE_STREAK) break;

            // Sufficiency gate: let the model decide it has seen enough to
            // satisfy the goal rather than blindly crawling up to maxPages.
            // Skipped while hunting for a specific action — we only stop then
            // when the action is found or links are exhausted.
            if (
                !action &&
                pagesExplored >= SUFFICIENCY_MIN_PAGES &&
                pagesExplored % SUFFICIENCY_CHECK_INTERVAL === 0
            ) {
                const enough = await assessExplorationSufficiency(model, goalText, summaries);
                if (enough) break;
            }
        }

        return {
            pagesVisited: newVisited,
            pageSummaries: summaries,
            domSummary: lastSummary,
            currentUrl: lastUrl,
            actionResult,
        };
    };
