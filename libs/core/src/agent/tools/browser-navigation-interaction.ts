import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import {
    clearBrowserAuthPrecondition,
    ensureBrowserStarted,
    getBoundBrowserSession,
    resolveAuthStorageStateDestination,
    resolveHeadless,
} from "./shared/browser-session";
import { buildPageSnapshot, formatToolError, snapshotAfterAction } from "./shared/format";
import { persistLinksDiscovery, persistPageDiscovery } from "./shared/site-db-cache";
import type { ActionResultData, AgentToolGroupDeps, PageSnapshot, ToolResult } from "./types";

/** Tool names owned by the browser navigation / interaction group. */
export const BROWSER_NAVIGATION_INTERACTION_TOOL_NAMES = [
    "startBrowser",
    "closeBrowser",
    "navigateTo",
    "clickElement",
    "fillInput",
    "pressKey",
    "captureCurrentPage",
    "waitForElement",
    "typeText",
    "hoverElement",
    "selectOption",
    "toggleCheckbox",
    "getCurrentUrl",
    "saveAuthState",
    "discoverLinks",
] as const;

export type BrowserNavigationInteractionToolName =
    (typeof BROWSER_NAVIGATION_INTERACTION_TOOL_NAMES)[number];

export function createBrowserNavigationInteractionTools(deps: AgentToolGroupDeps) {
    const { projectPath, getAuthPrecondition } = deps;

    return {
        startBrowser: tool({
            description:
                "Start a browser session for exploring and testing a web application. Call this before navigating to URLs.",
            inputSchema: z.object({
                headless: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe(
                        "Run in headless mode (true) or visible mode (false). Defaults to visible.",
                    ),
            }),
            execute: async (params): Promise<ToolResult<{ active: boolean }>> => {
                const { headless = false } = params as { headless?: boolean };
                const effectiveHeadless = resolveHeadless(headless);
                try {
                    const session = getBoundBrowserSession(projectPath);
                    await ensureBrowserStarted(
                        session,
                        projectPath,
                        getAuthPrecondition,
                        effectiveHeadless,
                        true,
                    );
                    return {
                        success: true,
                        data: { active: true },
                        message: `Browser started (headless: ${effectiveHeadless})`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to start browser: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        closeBrowser: tool({
            description: "Close the browser session when done with exploration.",
            inputSchema: z.object({}),
            execute: async (): Promise<ToolResult<{ closed: boolean }>> => {
                try {
                    const session = getBoundBrowserSession(projectPath);
                    await session.close();
                    clearBrowserAuthPrecondition(session);
                    return {
                        success: true,
                        data: { closed: true },
                        message: "Browser session closed",
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to close browser: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        navigateTo: tool({
            description:
                "Navigate to a URL in the browser and capture the page state. Automatically starts the browser if not running. Returns interactive elements and form fields found.",
            inputSchema: z.object({
                url: z.string().url().describe("URL to navigate to"),
            }),
            execute: async (params): Promise<ToolResult<PageSnapshot>> => {
                const { url } = params as { url: string };
                try {
                    const session = getBoundBrowserSession(projectPath);
                    await ensureBrowserStarted(session, projectPath, getAuthPrecondition);

                    let previousUrl: string | undefined;
                    try {
                        previousUrl = session.getCurrentUrl();
                    } catch {
                        /* browser just started */
                    }
                    const domContext = await session.navigate(url);
                    const snapshot = buildPageSnapshot(domContext);

                    persistPageDiscovery(projectPath, snapshot, previousUrl ?? undefined);

                    return {
                        success: true,
                        data: snapshot,
                        message: `Navigated to ${snapshot.title}: ${snapshot.elements} elements, ${snapshot.forms} form fields`,
                    };
                } catch (error) {
                    return formatToolError("Navigation failed", error);
                }
            },
        }),

        clickElement: tool({
            description: "Click an element on the page using a selector or array of selectors.",
            inputSchema: z.object({
                selector: z
                    .union([z.string(), z.array(z.string())])
                    .describe("Selector or array of DOM-derived selectors to try"),
            }),
            execute: async (params): Promise<ToolResult<ActionResultData>> => {
                const { selector } = params as { selector: string | string[] };
                try {
                    const session = getBoundBrowserSession(projectPath);
                    await ensureBrowserStarted(session, projectPath, getAuthPrecondition);
                    let prevUrl: string | undefined;
                    try {
                        prevUrl = session.getCurrentUrl();
                    } catch {
                        /* not started yet */
                    }
                    await session.click(selector);
                    const after = await snapshotAfterAction(session, prevUrl);
                    const target = Array.isArray(selector) ? selector[0] : selector;
                    return {
                        success: true,
                        data: { clicked: true, ...after },
                        message: `Clicked: ${target}${after.changed && after.url ? ` → ${after.url}` : ""}`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Click failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        fillInput: tool({
            description: "Fill an input field with text (clears existing value first).",
            inputSchema: z.object({
                selector: z
                    .union([z.string(), z.array(z.string())])
                    .describe("Selector or array of DOM-derived selectors to try"),
                value: z.string().describe("Value to fill"),
            }),
            execute: async (params): Promise<ToolResult<ActionResultData>> => {
                const { selector, value } = params as {
                    selector: string | string[];
                    value: string;
                };
                try {
                    const session = getBoundBrowserSession(projectPath);
                    await ensureBrowserStarted(session, projectPath, getAuthPrecondition);
                    let prevUrl: string | undefined;
                    try {
                        prevUrl = session.getCurrentUrl();
                    } catch {
                        /* not started yet */
                    }
                    await session.fill(selector, value);
                    const after = await snapshotAfterAction(session, prevUrl);
                    return {
                        success: true,
                        data: { filled: true, ...after },
                        message: `Filled ${Array.isArray(selector) ? selector[0] : selector} with value`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Fill failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        pressKey: tool({
            description: "Press a keyboard key (e.g., 'Enter', 'Tab', 'Escape').",
            inputSchema: z.object({
                key: z
                    .string()
                    .describe("Key to press (e.g., 'Enter', 'Tab', 'Escape', 'ArrowDown')"),
            }),
            execute: async (params): Promise<ToolResult<ActionResultData>> => {
                const { key } = params as { key: string };
                try {
                    const session = getBoundBrowserSession(projectPath);
                    await ensureBrowserStarted(session, projectPath, getAuthPrecondition);
                    let prevUrl: string | undefined;
                    try {
                        prevUrl = session.getCurrentUrl();
                    } catch {
                        /* not started yet */
                    }
                    await session.press(key);
                    const after = await snapshotAfterAction(session, prevUrl);
                    return {
                        success: true,
                        data: { pressed: true, ...after },
                        message: `Pressed: ${key}${after.changed && after.url ? ` → ${after.url}` : ""}`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Key press failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        captureCurrentPage: tool({
            description:
                "Capture the current page state without navigating. Use this after interactions to see what changed.",
            inputSchema: z.object({}),
            execute: async (): Promise<ToolResult<PageSnapshot>> => {
                try {
                    const session = getBoundBrowserSession(projectPath);
                    await ensureBrowserStarted(session, projectPath, getAuthPrecondition);
                    const domContext = await session.captureCurrentPage();
                    const snapshot = buildPageSnapshot(domContext);

                    return {
                        success: true,
                        data: snapshot,
                        message: `Captured ${snapshot.title}: ${snapshot.elements} elements`,
                    };
                } catch (error) {
                    return formatToolError("Capture failed", error);
                }
            },
        }),

        waitForElement: tool({
            description: "Wait for an element to appear on the page.",
            inputSchema: z.object({
                selector: z
                    .union([z.string(), z.array(z.string())])
                    .describe("Selector or array of selectors to wait for"),
                timeout: z.number().optional().default(5000).describe("Timeout in milliseconds"),
            }),
            execute: async (
                params,
            ): Promise<
                ToolResult<{ found: boolean; url?: string; summary?: string; captured?: boolean }>
            > => {
                const { selector, timeout } = params as {
                    selector: string | string[];
                    timeout?: number;
                };
                try {
                    const session = getBoundBrowserSession(projectPath);
                    await ensureBrowserStarted(session, projectPath, getAuthPrecondition);
                    await session.waitForSelector(selector, timeout);
                    const after = await snapshotAfterAction(session);
                    return {
                        success: true,
                        data: { found: true, ...after },
                        message: `Element found: ${Array.isArray(selector) ? selector[0] : selector}`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Wait failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        typeText: tool({
            description:
                "Type text character-by-character into a field. Use for React/controlled inputs when fillInput doesn't register the value.",
            inputSchema: z.object({
                selector: z
                    .union([z.string(), z.array(z.string())])
                    .describe("Selector or array of DOM-derived selectors to try"),
                text: z.string().describe("Text to type"),
            }),
            execute: async (params): Promise<ToolResult<ActionResultData>> => {
                const { selector, text } = params as { selector: string | string[]; text: string };
                try {
                    const session = getBoundBrowserSession(projectPath);
                    await ensureBrowserStarted(session, projectPath, getAuthPrecondition);
                    await session.type(selector, text);
                    const after = await snapshotAfterAction(session);
                    return {
                        success: true,
                        data: { filled: true, ...after },
                        message: `Typed into ${Array.isArray(selector) ? selector[0] : selector}`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Type failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        hoverElement: tool({
            description: "Hover over an element to reveal menus, tooltips, or hidden controls.",
            inputSchema: z.object({
                selector: z
                    .union([z.string(), z.array(z.string())])
                    .describe("Selector or array of DOM-derived selectors to try"),
            }),
            execute: async (params): Promise<ToolResult<ActionResultData>> => {
                const { selector } = params as { selector: string | string[] };
                try {
                    const session = getBoundBrowserSession(projectPath);
                    await ensureBrowserStarted(session, projectPath, getAuthPrecondition);
                    await session.hover(selector);
                    const after = await snapshotAfterAction(session);
                    return {
                        success: true,
                        data: { ...after },
                        message: `Hovered: ${Array.isArray(selector) ? selector[0] : selector}`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Hover failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        selectOption: tool({
            description: "Select an option from a dropdown/select element.",
            inputSchema: z.object({
                selector: z
                    .union([z.string(), z.array(z.string())])
                    .describe("Selector or array of selectors for the select element"),
                value: z.string().describe("Option value to select"),
            }),
            execute: async (params): Promise<ToolResult<ActionResultData>> => {
                const { selector, value } = params as {
                    selector: string | string[];
                    value: string;
                };
                try {
                    const session = getBoundBrowserSession(projectPath);
                    await ensureBrowserStarted(session, projectPath, getAuthPrecondition);
                    let prevUrl: string | undefined;
                    try {
                        prevUrl = session.getCurrentUrl();
                    } catch {
                        /* not started yet */
                    }
                    await session.selectOption(selector, value);
                    const after = await snapshotAfterAction(session, prevUrl);
                    return {
                        success: true,
                        data: { selected: true, ...after },
                        message: `Selected ${value} from ${Array.isArray(selector) ? selector[0] : selector}`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Select failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        toggleCheckbox: tool({
            description: "Check or uncheck a checkbox.",
            inputSchema: z.object({
                selector: z
                    .union([z.string(), z.array(z.string())])
                    .describe("Selector or array of selectors for the checkbox"),
                checked: z.boolean().describe("True to check, false to uncheck"),
            }),
            execute: async (params): Promise<ToolResult<ActionResultData>> => {
                const { selector, checked } = params as {
                    selector: string | string[];
                    checked: boolean;
                };
                try {
                    const session = getBoundBrowserSession(projectPath);
                    await ensureBrowserStarted(session, projectPath, getAuthPrecondition);
                    let prevUrl: string | undefined;
                    try {
                        prevUrl = session.getCurrentUrl();
                    } catch {
                        /* not started yet */
                    }
                    if (checked) {
                        await session.check(selector);
                    } else {
                        await session.uncheck(selector);
                    }
                    const after = await snapshotAfterAction(session, prevUrl);
                    return {
                        success: true,
                        data: { toggled: true, ...after },
                        message: `Checkbox ${checked ? "checked" : "unchecked"}: ${Array.isArray(selector) ? selector[0] : selector}`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Toggle failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        getCurrentUrl: tool({
            description: "Get the current URL of the browser.",
            inputSchema: z.object({}),
            execute: async (): Promise<ToolResult<{ url: string }>> => {
                try {
                    const session = getBoundBrowserSession(projectPath);
                    const url = session.getCurrentUrl();
                    return {
                        success: true,
                        data: { url },
                        message: `Current URL: ${url}`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to get URL: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        saveAuthState: tool({
            description:
                "Save the current browser authentication state (cookies, localStorage) so future sessions start already logged in. Call this after the user has manually logged in.",
            inputSchema: z.object({}),
            execute: async (): Promise<ToolResult<{ saved: boolean; path: string }>> => {
                try {
                    const session = getBoundBrowserSession(projectPath);
                    await ensureBrowserStarted(session, projectPath, getAuthPrecondition);
                    const authPath = resolveAuthStorageStateDestination(projectPath);
                    await fs.mkdir(path.dirname(authPath), { recursive: true });
                    await session.saveAuthState(authPath);
                    return {
                        success: true,
                        data: { saved: true, path: authPath },
                        message: `Auth state saved. Future sessions will start authenticated.`,
                    };
                } catch (error) {
                    return formatToolError("Failed to save auth state", error);
                }
            },
        }),

        discoverLinks: tool({
            description:
                "Quickly discover all links on the current page. Use this for app exploration before deciding which pages to visit. Faster than full page capture.",
            inputSchema: z.object({
                includeExternal: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Include external links (default: false)"),
            }),
            execute: async (
                params,
            ): Promise<
                ToolResult<{ links: Array<{ text: string; href: string }>; totalFound: number }>
            > => {
                const { includeExternal } = params as { includeExternal?: boolean };
                try {
                    const session = getBoundBrowserSession(projectPath);
                    await ensureBrowserStarted(session, projectPath, getAuthPrecondition);
                    const allLinks = await session.discoverLinks();

                    const links = includeExternal
                        ? allLinks
                        : allLinks.filter((l) => !l.isExternal);

                    const currentUrl = session.getCurrentUrl() ?? "";
                    const persisted = links.map((l) => ({
                        text: l.text,
                        href: l.href,
                        suggestedSelectors: l.suggestedSelectors,
                    }));
                    persistLinksDiscovery(projectPath, currentUrl, persisted);
                    const mapped = links.map((l) => ({ text: l.text, href: l.href }));

                    return {
                        success: true,
                        data: {
                            links: mapped,
                            totalFound: links.length,
                        },
                        message: `Found ${links.length} links on page`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to discover links: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),
    };
}

export type BrowserNavigationInteractionTools = ReturnType<
    typeof createBrowserNavigationInteractionTools
>;
