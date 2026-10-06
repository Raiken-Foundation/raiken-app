import * as readline from "node:readline";
import { createProjectApplication } from "@raiken/core";
import { safeCliErrorMessage } from "../errors";
import { getRaikenVersion } from "@raiken/shared";
import type { ProjectApplication } from "@raiken/core";

/**
 * `raiken mcp` — a minimal Model Context Protocol stdio server exposing the
 * contract as tools. Coding agents (Claude Code, Cursor, Zed) call these
 * while writing tests; the contract becomes ground truth they can query
 * instead of something they'd have to re-discover.
 *
 * Deliberately dependency-free: MCP stdio is newline-delimited JSON-RPC 2.0,
 * ~40 lines of framing. Read-only with respect to the app under test —
 * `contract_materialize` writes specs, never touches the app.
 */

const PROTOCOL_VERSION = "2024-11-05";

interface McpTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    execute: (args: Record<string, unknown>, app: ProjectApplication) => Promise<string>;
}

const TOOLS: McpTool[] = [
    {
        name: "contract_view",
        description:
            "The full behavior contract: observed facts (what the app verifiably does), intent requirements (tickets/ACs), and coverage.",
        inputSchema: { type: "object", properties: {} },
        execute: async (_args, app) => JSON.stringify(app.contract.view(), null, 2),
    },
    {
        name: "contract_coverage",
        description:
            "Requirement coverage: which ACs/tickets have matching observed facts, which are uncovered, which are violated.",
        inputSchema: { type: "object", properties: {} },
        execute: async (_args, app) => JSON.stringify(app.contract.coverage(), null, 2),
    },
    {
        name: "contract_changes",
        description:
            "Behavior changes between two commits: facts added, broken, fixed, accepted, or rejected, grouped by the commit they were observed at. `range` is git syntax (e.g. \"origin/main..HEAD\").",
        inputSchema: {
            type: "object",
            properties: { range: { type: "string" } },
            required: ["range"],
        },
        execute: async (args, app) => JSON.stringify(app.contract.changes(String(args["range"])), null, 2),
    },
    {
        name: "contract_facts",
        description: "Observed facts, optionally filtered by status and confidence.",
        inputSchema: {
            type: "object",
            properties: {
                status: { type: "string", enum: ["verified", "violated", "unverified", "retired"] },
                minConfidence: { type: "number" },
            },
        },
        execute: async (args, app) => {
            const facts = app.contract
                .view()
                .observed.filter((f) =>
                    args.status ? f.status === args.status : true,
                )
                .filter((f) =>
                    typeof args.minConfidence === "number" ? f.confidence >= args.minConfidence : true,
                );
            return JSON.stringify(facts, null, 2);
        },
    },
    {
        name: "contract_requirements",
        description: "Intent requirements with their coverage status and matching facts.",
        inputSchema: { type: "object", properties: {} },
        execute: async (_args, app) => {
            const report = app.contract.coverage();
            return JSON.stringify(report.entries, null, 2);
        },
    },
    {
        name: "contract_materialize",
        description:
            "Materialize disposable Playwright specs from verified facts into a directory.",
        inputSchema: {
            type: "object",
            properties: { outDir: { type: "string" } },
            required: ["outDir"],
        },
        execute: async (args, app) => {
            const result = app.contract.materialize({ outDir: String(args.outDir) });
            return JSON.stringify(result, null, 2);
        },
    },
];

interface JsonRpcMessage {
    jsonrpc?: string;
    id?: number | string | null;
    method?: string;
    params?: Record<string, unknown>;
}

export async function handleMcpMessage(
    message: JsonRpcMessage,
    app: ProjectApplication,
): Promise<Record<string, unknown> | null> {
    const id = message.id ?? null;
    switch (message.method) {
        case "initialize":
            return {
                jsonrpc: "2.0",
                id,
                result: {
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: { tools: {} },
                    serverInfo: { name: "raiken", version: getRaikenVersion() },
                },
            };
        case "notifications/initialized":
            return null;
        case "ping":
            return { jsonrpc: "2.0", id, result: {} };
        case "tools/list":
            return {
                jsonrpc: "2.0",
                id,
                result: {
                    tools: TOOLS.map((t) => ({
                        name: t.name,
                        description: t.description,
                        inputSchema: t.inputSchema,
                    })),
                },
            };
        case "tools/call": {
            const params = (message.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
            const tool = TOOLS.find((t) => t.name === params.name);
            if (!tool) {
                return {
                    jsonrpc: "2.0",
                    id,
                    error: { code: -32602, message: `Unknown tool: ${params.name}` },
                };
            }
            try {
                const text = await tool.execute(params.arguments ?? {}, app);
                return {
                    jsonrpc: "2.0",
                    id,
                    result: { content: [{ type: "text", text }] },
                };
            } catch (error) {
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [
                            { type: "text", text: `Error: ${safeCliErrorMessage(error)}` },
                        ],
                        isError: true,
                    },
                };
            }
        }
        default:
            return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
    }
}

/** Stdio loop: newline-delimited JSON-RPC in, responses out. */
export async function mcpCommand(): Promise<void> {
    const app = createProjectApplication(process.cwd());
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    for await (const line of rl) {
        if (!line.trim()) continue;
        let message: JsonRpcMessage;
        try {
            message = JSON.parse(line) as JsonRpcMessage;
        } catch {
            continue; // non-JSON on stdio is ignored per MCP framing
        }
        try {
            const response = await handleMcpMessage(message, app);
            if (response) {
                process.stdout.write(`${JSON.stringify(response)}\n`);
            }
        } catch {
            // A failed handler must never kill the server loop.
        }
    }
}
