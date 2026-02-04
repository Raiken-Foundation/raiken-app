/**
 * Agent Tools - AI SDK Tool Definitions
 *
 * These tools are available to the LLM during reasoning.
 * The LLM decides when to call each tool based on the user's request.
 */

import { tool } from "ai";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ProjectContext } from "../analysis/project-context";
import { AgentMemory } from "./memory";
import { TestRunner, type TestRunResult } from "../testing/runner";
import { captureDOMContext, formatDOMContext, type DOMContext } from "../browser/dom-capture";
import { createSaveAction, createRunAction, shouldSkipHITL, type HITLAction } from "./hitl-types";
import { BrowserSession } from "../browser/session";
export type { HITLAction } from "./hitl-types";

interface PageSnapshot {
    url: string;
    title: string;
    elements: number;
    forms: number;
    summary: string;
}

function buildPageSnapshot(domContext: DOMContext): PageSnapshot {
    const summary = formatDOMContext(domContext);
    return {
        url: domContext.url,
        title: domContext.title,
        elements: domContext.interactiveElements.length,
        forms: domContext.formFields.length,
        summary,
    };
}

function formatToolError<T = unknown>(context: string, error: unknown): ToolResult<T> {
    return {
        success: false,
        message: `${context}: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
}

/**
 * Autonomy settings for tool execution
 */
export interface AutonomySettings {
    autoSaveTests: boolean;
    autoRunTests: boolean;
    autoCorrect: "suggest" | "apply" | "off";
    autoLearn: "confirm" | "auto" | "off";
}

/**
 * Tool result that may require HITL confirmation
 */
export interface ToolResult<T = unknown> {
    success: boolean;
    data?: T;
    message: string;
    hitlRequired?: boolean;
    hitlAction?: HITLAction;
}

/**
 * Context passed to tool factory functions
 */
export interface ToolContext {
    projectPath: string;
    /** Autonomy settings for HITL decisions */
    autonomy?: AutonomySettings;
}

/**
 * Default autonomy settings (conservative - always ask)
 */
const defaultAutonomy: AutonomySettings = {
    autoSaveTests: false,
    autoRunTests: false,
    autoCorrect: "suggest",
    autoLearn: "confirm",
};

/**
 * Create the agent tools with project context
 */
export function createAgentTools(ctx: ToolContext) {
    const { projectPath, autonomy = defaultAutonomy } = ctx;

    return {
        /**
         * Search the codebase for files related to a query
         */
        searchCodebase: tool({
            description:
                "Search the codebase for files related to a query. Use this to find relevant source files before reading them.",
            inputSchema: z.object({
                query: z.string().describe('Search query (e.g., "login form", "auth service", "user validation")'),
                limit: z.number().optional().default(10).describe("Maximum number of files to return"),
            }),
            execute: async (params): Promise<ToolResult<string[]>> => {
                const { query, limit = 10 } = params as { query: string; limit?: number };
                try {
                    const projectContext = ProjectContext.getInstance(projectPath);
                    if (!projectContext.isInitialized()) {
                        await projectContext.initialize();
                    }
                    const files = projectContext.findRelevantFiles(query, limit);
                    return {
                        success: true,
                        data: files,
                        message: files.length > 0 ? `Found ${files.length} relevant files` : "No matching files found",
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Read the contents of a file
         */
        readFile: tool({
            description: "Read the contents of a source file. Use this to understand code before generating tests.",
            inputSchema: z.object({
                filePath: z.string().describe("File path relative to project root (e.g., src/components/LoginForm.tsx)"),
            }),
            execute: async (params): Promise<ToolResult<{ content: string; lines: number }>> => {
                const { filePath } = params as { filePath: string };
                try {
                    const fullPath = path.join(projectPath, filePath);
                    const content = await fs.readFile(fullPath, "utf-8");
                    const lines = content.split("\n").length;
                    return {
                        success: true,
                        data: { content, lines },
                        message: `Read ${filePath} (${lines} lines)`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to read file: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * List files in a directory
         */
        listDirectory: tool({
            description: "List files in a directory. Use this to explore the project structure.",
            inputSchema: z.object({
                dirPath: z.string().describe("Directory path relative to project root (e.g., src/components)"),
            }),
            execute: async (params): Promise<ToolResult<string[]>> => {
                const { dirPath } = params as { dirPath: string };
                try {
                    const fullPath = path.join(projectPath, dirPath);
                    const entries = await fs.readdir(fullPath, { withFileTypes: true });
                    const files = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
                    return {
                        success: true,
                        data: files,
                        message: `Found ${files.length} items in ${dirPath}`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to list directory: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Capture the live DOM from a running web application
         */
        captureDOM: tool({
            description:
                "Capture the live DOM from a running web application. Use this to understand the current UI state for test generation.",
            inputSchema: z.object({
                url: z.string().url().describe("URL to capture (e.g., http://localhost:3000/login)"),
            }),
            execute: async (params): Promise<ToolResult<{ summary: string; elementCount: number; formCount: number }>> => {
                const { url } = params as { url: string };
                try {
                    // Check for auth config
                    let storageStatePath: string | undefined;
                    try {
                        const configPath = path.join(projectPath, "raiken.config.json");
                        const configContent = await fs.readFile(configPath, "utf-8");
                        const config = JSON.parse(configContent);
                        storageStatePath = config.auth?.storageStatePath;
                    } catch {
                        // Config not found
                    }

                    const domContext = await captureDOMContext(url, { storageStatePath });
                    const summary = formatDOMContext(domContext);

                    return {
                        success: true,
                        data: {
                            summary,
                            elementCount: domContext.interactiveElements.length,
                            formCount: domContext.formFields.length,
                        },
                        message: `Captured DOM: ${domContext.interactiveElements.length} interactive elements, ${domContext.formFields.length} form fields`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `DOM capture failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Save a file to the project
         * Checks autonomy settings - either saves immediately or returns HITL action
         */
        saveFile: tool({
            description:
                "Save content to a file. Depending on autonomy settings, this may save immediately or ask for confirmation.",
            inputSchema: z.object({
                filePath: z.string().describe("File path relative to project root (e.g., tests/login.spec.ts)"),
                content: z.string().describe("File content to save"),
                testName: z.string().optional().describe("Name of the test (for display)"),
            }),
            execute: async (params): Promise<ToolResult<{ path: string; saved: boolean }>> => {
                const { filePath, content, testName } = params as { filePath: string; content: string; testName?: string };
                const name = testName || path.basename(filePath, path.extname(filePath));

                // Check if we can skip HITL
                if (shouldSkipHITL("save", autonomy)) {
                    // Auto-save enabled - save immediately
                    try {
                        const fullPath = path.join(projectPath, filePath);
                        // Ensure directory exists
                        await fs.mkdir(path.dirname(fullPath), { recursive: true });
                        await fs.writeFile(fullPath, content, "utf-8");
                        return {
                            success: true,
                            data: { path: filePath, saved: true },
                            message: `Saved ${filePath}`,
                        };
                    } catch (error) {
                        return {
                            success: false,
                            message: `Failed to save file: ${error instanceof Error ? error.message : "Unknown error"}`,
                        };
                    }
                }

                // HITL required - return action for confirmation
                const hitlAction = createSaveAction(content, filePath, name);
                return {
                    success: true,
                    data: { path: filePath, saved: false },
                    message: `Ready to save ${filePath}. Waiting for confirmation.`,
                    hitlRequired: true,
                    hitlAction,
                };
            },
        }),

        /**
         * Run a Playwright test file
         * Checks autonomy settings - either runs immediately or returns HITL action
         */
        runTest: tool({
            description:
                "Execute a Playwright test file and return results. Depending on autonomy settings, this may run immediately or ask for confirmation.",
            inputSchema: z.object({
                testFile: z.string().describe("Test file path relative to project root"),
                headed: z.boolean().optional().default(false).describe("Run with visible browser"),
            }),
            execute: async (params): Promise<ToolResult<TestRunResult[] | { status: string }>> => {
                const { testFile, headed = false } = params as { testFile: string; headed?: boolean };

                // Check if we can skip HITL
                if (shouldSkipHITL("run", autonomy)) {
                    // Auto-run enabled - execute immediately
                    try {
                        const runner = new TestRunner(projectPath);
                        const results = await runner.runTest(testFile, { headed });
                        const passed = results.every((r) => r.status === "passed");

                        return {
                            success: passed,
                            data: results,
                            message: passed
                                ? `All tests passed (${results.length} test(s))`
                                : `${results.filter((r) => r.status !== "passed").length} test(s) failed`,
                        };
                    } catch (error) {
                        return {
                            success: false,
                            message: `Test execution failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                        };
                    }
                }

                // HITL required - return action for confirmation
                const hitlAction = createRunAction(testFile, path.basename(testFile));
                return {
                    success: true,
                    data: { status: "pending" },
                    message: `Ready to run ${testFile}. Waiting for confirmation.`,
                    hitlRequired: true,
                    hitlAction,
                };
            },
        }),

        /**
         * Get memory context (learned preferences, selector history)
         */
        getMemoryContext: tool({
            description:
                "Get learned preferences and selector history. Use this to understand what has worked in the past.",
            inputSchema: z.object({}),
            execute: async (): Promise<
                ToolResult<{
                    selectorStrategy: string | null;
                    successfulSelectors: Array<{ element: string; selector: string }>;
                    recentFailures: Array<{ testName: string; error: string }>;
                }>
            > => {
                try {
                    const memory = AgentMemory.getInstance(projectPath);
                    const context = memory.buildPromptContext();

                    return {
                        success: true,
                        data: {
                            selectorStrategy: context.selectorStrategy,
                            successfulSelectors: context.successfulSelectors.map((s) => ({
                                element: s.element,
                                selector: s.selector,
                            })),
                            recentFailures: context.recentFailures,
                        },
                        message: `Loaded memory: ${context.successfulSelectors.length} known selectors, ${context.recentFailures.length} recent failures`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to load memory: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Get project structure overview
         */
        getProjectOverview: tool({
            description: "Get an overview of the project structure including modules and file counts.",
            inputSchema: z.object({}),
            execute: async (): Promise<
                ToolResult<{
                    fileCount: number;
                    modules: Array<{ name: string; fileCount: number }>;
                }>
            > => {
                try {
                    const projectContext = ProjectContext.getInstance(projectPath);
                    if (!projectContext.isInitialized()) {
                        await projectContext.initialize();
                    }

                    const modules = projectContext.getModules();
                    const fileCount = projectContext.getFileCount();

                    return {
                        success: true,
                        data: {
                            fileCount,
                            modules: modules.slice(0, 10).map((m) => ({
                                name: m.name,
                                fileCount: m.files.length,
                            })),
                        },
                        message: `Project has ${fileCount} files across ${modules.length} modules`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to get project overview: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        // =====================================================================
        // Browser Session Tools
        // =====================================================================

        /**
         * Start a browser session for web app exploration
         */
        startBrowser: tool({
            description: "Start a browser session for exploring and testing a web application. Call this before navigating to URLs.",
            inputSchema: z.object({
                headless: z.boolean().optional().default(false).describe("Run in headless mode (true) or visible mode (false). Defaults to visible."),
            }),
            execute: async (params): Promise<ToolResult<{ active: boolean }>> => {
                const { headless = false } = params as { headless?: boolean };
                try {
                    const session = BrowserSession.getInstance(projectPath);
                    
                    // Load auth state path from config if exists
                    let storageStatePath: string | undefined;
                    try {
                        const configPath = path.join(projectPath, "raiken.config.json");
                        const configContent = await fs.readFile(configPath, "utf-8");
                        const config = JSON.parse(configContent);
                        storageStatePath = config.auth?.storageStatePath;
                    } catch {
                        // Config not found
                    }
                    
                    await session.start({ headless, storageStatePath });
                    return {
                        success: true,
                        data: { active: true },
                        message: `Browser started (headless: ${headless})`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to start browser: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Close the browser session
         */
        closeBrowser: tool({
            description: "Close the browser session when done with exploration.",
            inputSchema: z.object({}),
            execute: async (): Promise<ToolResult<{ closed: boolean }>> => {
                try {
                    const session = BrowserSession.getInstance(projectPath);
                    await session.close();
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

        /**
         * Navigate to a URL and capture the page
         */
        navigateTo: tool({
            description: "Navigate to a URL in the browser and capture the page state. Automatically starts the browser if not running. Returns interactive elements and form fields found.",
            inputSchema: z.object({
                url: z.string().url().describe("URL to navigate to"),
            }),
            execute: async (params): Promise<ToolResult<PageSnapshot>> => {
                const { url } = params as { url: string };
                try {
                    const session = BrowserSession.getInstance(projectPath);
                    if (!session.isActive()) {
                        // Auto-start browser in visible mode for better debugging
                        await session.start({ headless: false });
                    }
                    
                    const domContext = await session.navigate(url);
                    const snapshot = buildPageSnapshot(domContext);

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

        /**
         * Click an element on the page
         */
        clickElement: tool({
            description: "Click an element on the page using a selector.",
            inputSchema: z.object({
                selector: z.string().describe("CSS selector or Playwright selector (e.g., 'button', '#submit', '[data-testid=\"login\"]')"),
            }),
            execute: async (params): Promise<ToolResult<{ clicked: boolean }>> => {
                const { selector } = params as { selector: string };
                try {
                    const session = BrowserSession.getInstance(projectPath);
                    await session.click(selector);
                    return {
                        success: true,
                        data: { clicked: true },
                        message: `Clicked: ${selector}`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Click failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Fill an input field
         */
        fillInput: tool({
            description: "Fill an input field with text (clears existing value first).",
            inputSchema: z.object({
                selector: z.string().describe("CSS selector for the input field"),
                value: z.string().describe("Value to fill"),
            }),
            execute: async (params): Promise<ToolResult<{ filled: boolean }>> => {
                const { selector, value } = params as { selector: string; value: string };
                try {
                    const session = BrowserSession.getInstance(projectPath);
                    await session.fill(selector, value);
                    return {
                        success: true,
                        data: { filled: true },
                        message: `Filled ${selector} with value`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Fill failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Press a keyboard key
         */
        pressKey: tool({
            description: "Press a keyboard key (e.g., 'Enter', 'Tab', 'Escape').",
            inputSchema: z.object({
                key: z.string().describe("Key to press (e.g., 'Enter', 'Tab', 'Escape', 'ArrowDown')"),
            }),
            execute: async (params): Promise<ToolResult<{ pressed: boolean }>> => {
                const { key } = params as { key: string };
                try {
                    const session = BrowserSession.getInstance(projectPath);
                    await session.press(key);
                    return {
                        success: true,
                        data: { pressed: true },
                        message: `Pressed: ${key}`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Key press failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Capture current page state
         */
        captureCurrentPage: tool({
            description: "Capture the current page state without navigating. Use this after interactions to see what changed.",
            inputSchema: z.object({}),
            execute: async (): Promise<ToolResult<PageSnapshot>> => {
                try {
                    const session = BrowserSession.getInstance(projectPath);
                    if (!session.isActive()) {
                        await session.start({ headless: false });
                    }
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

        /**
         * Wait for an element to appear
         */
        waitForElement: tool({
            description: "Wait for an element to appear on the page.",
            inputSchema: z.object({
                selector: z.string().describe("CSS selector to wait for"),
                timeout: z.number().optional().default(5000).describe("Timeout in milliseconds"),
            }),
            execute: async (params): Promise<ToolResult<{ found: boolean }>> => {
                const { selector, timeout } = params as { selector: string; timeout?: number };
                try {
                    const session = BrowserSession.getInstance(projectPath);
                    await session.waitForSelector(selector, timeout);
                    return {
                        success: true,
                        data: { found: true },
                        message: `Element found: ${selector}`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Wait failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Select option from dropdown
         */
        selectOption: tool({
            description: "Select an option from a dropdown/select element.",
            inputSchema: z.object({
                selector: z.string().describe("CSS selector for the select element"),
                value: z.string().describe("Option value to select"),
            }),
            execute: async (params): Promise<ToolResult<{ selected: boolean }>> => {
                const { selector, value } = params as { selector: string; value: string };
                try {
                    const session = BrowserSession.getInstance(projectPath);
                    await session.selectOption(selector, value);
                    return {
                        success: true,
                        data: { selected: true },
                        message: `Selected ${value} from ${selector}`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Select failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Check or uncheck a checkbox
         */
        toggleCheckbox: tool({
            description: "Check or uncheck a checkbox.",
            inputSchema: z.object({
                selector: z.string().describe("CSS selector for the checkbox"),
                checked: z.boolean().describe("True to check, false to uncheck"),
            }),
            execute: async (params): Promise<ToolResult<{ toggled: boolean }>> => {
                const { selector, checked } = params as { selector: string; checked: boolean };
                try {
                    const session = BrowserSession.getInstance(projectPath);
                    if (checked) {
                        await session.check(selector);
                    } else {
                        await session.uncheck(selector);
                    }
                    return {
                        success: true,
                        data: { toggled: true },
                        message: `Checkbox ${checked ? "checked" : "unchecked"}: ${selector}`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Toggle failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Get current URL
         */
        getCurrentUrl: tool({
            description: "Get the current URL of the browser.",
            inputSchema: z.object({}),
            execute: async (): Promise<ToolResult<{ url: string }>> => {
                try {
                    const session = BrowserSession.getInstance(projectPath);
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

        /**
         * Discover all links on the current page (lightweight, for exploration)
         */
        discoverLinks: tool({
            description: "Quickly discover all links on the current page. Use this for app exploration before deciding which pages to visit. Faster than full page capture.",
            inputSchema: z.object({
                includeExternal: z.boolean().optional().default(false).describe("Include external links (default: false)"),
            }),
            execute: async (params): Promise<ToolResult<{ links: Array<{ text: string; href: string }>; totalFound: number }>> => {
                const { includeExternal } = params as { includeExternal?: boolean };
                try {
                    const session = BrowserSession.getInstance(projectPath);
                    if (!session.isActive()) {
                        await session.start({ headless: false });
                    }
                    const allLinks = await session.discoverLinks();
                    
                    const links = includeExternal 
                        ? allLinks 
                        : allLinks.filter(l => !l.isExternal);
                    
                    return {
                        success: true,
                        data: {
                            links: links.map(l => ({ text: l.text, href: l.href })),
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

        // =====================================================================
        // Agent Control Tools (for ToolLoopAgent forced tool calling)
        // =====================================================================

        /**
         * Signal task completion - NO execute function, stops the agent loop
         */
        done: tool({
            description: "Signal that you have finished the task. Call this when exploration is complete or when you have completed the user's request. This stops the agent loop.",
            inputSchema: z.object({
                summary: z.string().describe("Summary of what you found or did"),
                suggestedTests: z.array(z.string()).optional().describe("List of suggested test scenarios based on exploration"),
                pagesVisited: z.array(z.string()).optional().describe("List of pages/URLs that were visited"),
            }),
            // NO execute function - calling this tool stops the agent loop
        }),

        /**
         * Send a message to the user - for questions or progress updates
         */
        respond: tool({
            description: "Send a message to the user. Use this when you need to ask a clarifying question, report progress, or provide information that requires user acknowledgment before continuing.",
            inputSchema: z.object({
                message: z.string().describe("Message to send to the user"),
                needsInput: z.boolean().optional().default(false).describe("Whether you need user input to continue (true = wait for response)"),
                options: z.array(z.string()).optional().describe("Optional list of choices for the user to pick from"),
            }),
            execute: async (params): Promise<ToolResult<{ messageSent: boolean; awaitingInput: boolean }>> => {
                const { message, needsInput = false, options } = params as { 
                    message: string; 
                    needsInput?: boolean; 
                    options?: string[] 
                };
                return {
                    success: true,
                    data: { messageSent: true, awaitingInput: needsInput },
                    message: options ? `${message}\nOptions: ${options.join(", ")}` : message,
                };
            },
        }),

        /**
         * Pause and wait for user input (no execute function)
         * Use this when you need the user to respond before continuing.
         */
        awaitUser: tool({
            description: "Pause and ask the user for input. This stops the agent loop until the user responds.",
            inputSchema: z.object({
                message: z.string().describe("Question or prompt for the user"),
                options: z.array(z.string()).optional().describe("Optional list of choices for the user to pick from"),
            }),
            // NO execute function - calling this tool pauses the agent loop
        }),
    };
}

/**
 * Type for the tools object
 */
export type AgentTools = ReturnType<typeof createAgentTools>;
