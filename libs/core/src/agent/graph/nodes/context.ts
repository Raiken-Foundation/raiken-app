import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import path from "node:path";
import type { GraphStateType } from "../state";
import { NO_CONTEXT_HELP_MESSAGE, NO_EXPLORATION_CONTEXT_MESSAGE } from "../../prompts";
import type { AgentNodeDeps } from "./types";
import { ProjectContext } from "../../../analysis/project-context";
import { normalizeSelector, parseSummaryElements } from "../utils";

export const createGatherContextNode =
    ({ gatherContext, projectPath }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        const contextPrompt = state.activeGoal || state.targetFeature || state.userPrompt;
        const context = await gatherContext(contextPrompt, projectPath);
        return {
            context,
            testDirectory: context.testDirectory,
        };
    };

export const createGenerateTestsNode =
    ({ gatherContext, projectPath, model, buildSystemPrompt, getMemoryContext }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        const context = state.context || (await gatherContext(state.userPrompt, projectPath));
        if (context.files.length === 0 && !state.domSummary) {
            return {
                summary: NO_CONTEXT_HELP_MESSAGE,
            };
        }

        const memoryContext = getMemoryContext();
        let systemPrompt = buildSystemPrompt(context, state.userPrompt, "golden-v1", memoryContext);
        if (state.domSummary) {
            systemPrompt = `${systemPrompt}\n\n${state.domSummary}`;
        }

        if (state.conversationHistory && state.conversationHistory.length > 0) {
            const historyText = state.conversationHistory
                .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`)
                .join("\n\n");
            systemPrompt = `[CONVERSATION CONTEXT]\n${historyText}\n\n---\n\n${systemPrompt}`;
        }

        const response = await model.invoke([
            new SystemMessage(systemPrompt),
            new HumanMessage(state.userPrompt),
        ]);
        const content = Array.isArray(response.content)
            ? response.content
                  .map((part) => (typeof part === "string" ? part : part?.text || ""))
                  .join("")
            : response.content;

        return {
            testDraft: content || "",
            context,
            testDirectory: context.testDirectory,
        };
    };

export const createAnswerQuestionsNode =
    ({
        callTool,
        gatherContext,
        projectPath,
        model,
        buildExplorationPrompt,
        getMemoryContext,
    }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        if (state.nextTool === "discoveryRead") {
            const formatDate = (value: number | null | undefined): string => {
                if (typeof value !== "number" || !Number.isFinite(value)) {
                    return "n/a";
                }
                return new Date(value).toISOString();
            };
            const requestedUrl = state.targetUrl;
            const shouldListPages = !requestedUrl;
            const shouldFetchSnapshot = Boolean(requestedUrl);

            const overviewResult = await callTool("getDiscoveryOverview", {});
            if (!overviewResult.success || !overviewResult.data) {
                return {
                    summary:
                        "Answers:\n- I could not load discovery data right now.\n\nEvidence:\n- getDiscoveryOverview returned an error.\n\nUnknowns / Next checks:\n- Verify discovery DB access and try again.",
                };
            }

            const overview = overviewResult.data as {
                stats: {
                    pagesCount: number;
                    linksCount: number;
                    verifiedLinksCount: number;
                    brokenLinksCount: number;
                    unresolvedBlockersCount: number;
                };
                latestSession: {
                    startUrl: string;
                    status: string;
                    startedAt: number;
                    completedAt: number | null;
                    blockedAtUrl: string | null;
                } | null;
            };

            if (overview.stats.pagesCount === 0) {
                return {
                    summary:
                        "Answers:\n- There are no discovered pages persisted yet.\n- Run site discovery first, then I can fetch pages and snapshots in chat.\n\nEvidence:\n- getDiscoveryOverview reports pagesCount = 0.\n\nUnknowns / Next checks:\n- Start a discovery run (for example `raiken discover <url>`), then ask me to list pages or show a snapshot URL.",
                };
            }

            const lines: string[] = [];
            lines.push("Answers:");
            lines.push(
                `- Discovery data is available: ${overview.stats.pagesCount} pages, ${overview.stats.linksCount} links, ${overview.stats.verifiedLinksCount} verified links.`
            );
            if (overview.latestSession) {
                lines.push(
                    `- Latest session is ${overview.latestSession.status} (start: ${overview.latestSession.startUrl}).`
                );
            }
            if (overview.stats.unresolvedBlockersCount > 0) {
                lines.push(
                    `- There are ${overview.stats.unresolvedBlockersCount} unresolved auth blockers.`
                );
            }

            if (shouldListPages) {
                const pagesResult = await callTool("listDiscoveredPages", {
                    limit: 15,
                    offset: 0,
                });
                if (pagesResult.success && pagesResult.data) {
                    const pagesData = pagesResult.data as {
                        pages: Array<{
                            url: string;
                            title: string | null;
                            depth: number;
                            visitCount: number;
                        }>;
                        total: number;
                        hasMore: boolean;
                    };
                    const listed = pagesData.pages.slice(0, 8);
                    if (listed.length > 0) {
                        lines.push(`- Top discovered pages (${listed.length}/${pagesData.total} shown):`);
                        for (const page of listed) {
                            lines.push(
                                `  - ${page.url} (depth ${page.depth}, visits ${page.visitCount}, title: ${page.title || "Untitled"})`
                            );
                        }
                        if (pagesData.hasMore) {
                            lines.push("- More pages are available; ask for the next batch if needed.");
                        }
                    }
                }
            }

            if (shouldFetchSnapshot) {
                if (!requestedUrl) {
                    return {
                        summary:
                            "Answers:\n- I can fetch a discovered snapshot, but I need the exact page URL.\n\nEvidence:\n- nextTool was set to discoveryRead without a targetUrl.\n\nUnknowns / Next checks:\n- Provide the full page URL from discovery and ask again.",
                    };
                }
                const snapshotResult = await callTool("getDiscoveredPageSnapshot", {
                    url: requestedUrl,
                });
                if (snapshotResult.success) {
                    const snapshot = snapshotResult.data as
                        | {
                              url: string;
                              title: string | null;
                              depth: number;
                              snapshotJson: string | null;
                          }
                        | null;
                    if (!snapshot) {
                        lines.push(`- No persisted snapshot was found for ${requestedUrl}.`);
                    } else if (!snapshot.snapshotJson) {
                        lines.push(`- Snapshot exists for ${requestedUrl}, but the stored payload is empty.`);
                    } else {
                        const preview =
                            snapshot.snapshotJson.length > 700
                                ? `${snapshot.snapshotJson.slice(0, 700)}...`
                                : snapshot.snapshotJson;
                        lines.push(
                            `- Snapshot preview for ${snapshot.url} (depth ${snapshot.depth}, title: ${snapshot.title || "Untitled"}):`
                        );
                        lines.push(`  ${preview}`);
                    }
                }
            }

            lines.push("");
            lines.push("Evidence:");
            lines.push("- Tool: getDiscoveryOverview");
            if (shouldListPages) {
                lines.push("- Tool: listDiscoveredPages");
            }
            if (shouldFetchSnapshot && requestedUrl) {
                lines.push("- Tool: getDiscoveredPageSnapshot");
            }
            if (overview.latestSession) {
                lines.push(
                    `- Session timestamps: started ${formatDate(overview.latestSession.startedAt)}, completed ${formatDate(overview.latestSession.completedAt)}`
                );
            }

            lines.push("");
            lines.push("Unknowns / Next checks:");
            lines.push("- None.");

            return {
                summary: lines.join("\n"),
            };
        }

        const context = state.context || (await gatherContext(state.userPrompt, projectPath));
        if (context.files.length === 0 && !state.domSummary) {
            return {
                summary: NO_EXPLORATION_CONTEXT_MESSAGE,
            };
        }

        const memoryContext = getMemoryContext();
        let systemPrompt = buildExplorationPrompt(context, state.userPrompt, memoryContext, state.intent, {
            activeGoal: state.activeGoal,
            targetFeature: state.targetFeature,
            targetUrl: state.targetUrl,
            missingContext: state.missingContext,
            nextTool: state.nextTool,
        });
        if (state.domSummary) {
            systemPrompt = `${systemPrompt}\n\n[DOM SUMMARY]\n${state.domSummary}`;
        }

        if (state.conversationHistory && state.conversationHistory.length > 0) {
            const historyText = state.conversationHistory
                .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`)
                .join("\n\n");
            systemPrompt = `[CONVERSATION CONTEXT]\n${historyText}\n\n---\n\n${systemPrompt}`;
        }

        const extractEvidenceInfo = (text: string): {
            hasEvidence: boolean;
            filePaths: string[];
            selectors: string[];
        } => {
            const lines = text.split("\n");
            let inEvidence = false;
            const evidenceLines: string[] = [];
            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (/^#{0,6}\s*Evidence\s*:?\s*$/i.test(line)) {
                    inEvidence = true;
                    continue;
                }
                if (inEvidence && /^#{0,6}\s*Unknowns/i.test(line)) {
                    break;
                }
                if (inEvidence) {
                    evidenceLines.push(line);
                }
            }
            if (evidenceLines.length === 0) {
                return { hasEvidence: false, filePaths: [], selectors: [] };
            }
            const filePathPattern = /\b[\w./-]+\.(ts|tsx|js|jsx|md|json|yaml|yml|css|scss|html|txt)\b/i;
            const domPattern = /\bDOM\b|selector|getByRole|getByTestId|data-testid|aria/i;
            const filePaths = evidenceLines.flatMap((line) => {
                const matches = line.match(filePathPattern);
                return matches ? matches : [];
            });
            const selectors = new Set<string>();
            for (const line of evidenceLines) {
                const selectorMatch = line.match(/^Selector:\s+(.+)$/i);
                if (selectorMatch?.[1]) {
                    selectors.add(selectorMatch[1].trim());
                }
                const locatorMatches = line.match(
                    /getBy(Role|TestId|Text|Label|Placeholder|AltText|Title)\([^)]+\)/g
                );
                if (locatorMatches) {
                    for (const match of locatorMatches) {
                        selectors.add(match);
                    }
                }
                const dataTestIdMatches = line.match(/\[data-testid=["'][^"']+["']\]/g);
                if (dataTestIdMatches) {
                    for (const match of dataTestIdMatches) {
                        selectors.add(match);
                    }
                }
                const labelMatches = line.match(/label=("[^"]+"|'[^']+'|[^\s]+)/g);
                if (labelMatches) {
                    for (const match of labelMatches) {
                        selectors.add(match);
                    }
                }
                const placeholderMatches = line.match(/placeholder=("[^"]+"|'[^']+'|[^\s]+)/g);
                if (placeholderMatches) {
                    for (const match of placeholderMatches) {
                        selectors.add(match);
                    }
                }
                const altMatches = line.match(/alt=("[^"]+"|'[^']+'|[^\s]+)/g);
                if (altMatches) {
                    for (const match of altMatches) {
                        selectors.add(match);
                    }
                }
                const titleMatches = line.match(/title=("[^"]+"|'[^']+'|[^\s]+)/g);
                if (titleMatches) {
                    for (const match of titleMatches) {
                        selectors.add(match);
                    }
                }
                const cssMatches = line.match(/css=("[^"]+"|'[^']+'|[^\s]+)/g);
                if (cssMatches) {
                    for (const match of cssMatches) {
                        selectors.add(match);
                    }
                }
                const xpathMatches = line.match(/xpath=("[^"]+"|'[^']+'|[^\s]+)/g);
                if (xpathMatches) {
                    for (const match of xpathMatches) {
                        selectors.add(match);
                    }
                }
                const roleMatches = line.match(/role=[^\s\]]+(?:\[name="[^"]+"\])?/g);
                if (roleMatches) {
                    for (const match of roleMatches) {
                        selectors.add(match);
                    }
                }
                const textMatches = line.match(/text=("[^"]+"|'[^']+'|[^\s]+)/g);
                if (textMatches) {
                    for (const match of textMatches) {
                        selectors.add(match);
                    }
                }
            }
            const hasEvidence = evidenceLines.some(
                (line) => filePathPattern.test(line) || domPattern.test(line)
            );
            return { hasEvidence, filePaths, selectors: Array.from(selectors) };
        };

        const invokeWithPrompt = async (prompt: string): Promise<string> => {
            const response = await model.invoke([
                new SystemMessage(prompt),
                new HumanMessage(state.userPrompt),
            ]);
            return Array.isArray(response.content)
                ? response.content
                      .map((part) => (typeof part === "string" ? part : part?.text || ""))
                      .join("")
                : response.content;
        };

        const normalizeEvidencePath = (value: string): string => {
            const cleaned = value.replace(/^[`"'[(]+|[`"')\],.:;]+$/g, "");
            if (path.isAbsolute(cleaned)) {
                return path.relative(projectPath, cleaned);
            }
            return cleaned;
        };

        let content = await invokeWithPrompt(systemPrompt);
        if (typeof content === "string") {
            const evidence = extractEvidenceInfo(content);
            if (!evidence.hasEvidence) {
                content = `${content}\n\nNote: Evidence section lacks file paths or DOM references.`;
            } else if (evidence.filePaths.length > 0) {
                const projectContext = ProjectContext.getInstance(projectPath);
                if (!projectContext.isInitialized()) {
                    await projectContext.initialize();
                }
                const repoFileSet = new Set(projectContext.getAllFilePaths());
                const contextFileSet = new Set(context.files.map((file) => file.path));
                const normalized = evidence.filePaths.map(normalizeEvidencePath);
                const missingInRepo = normalized.filter((filePath) => !repoFileSet.has(filePath));
                const missingInContext = normalized.filter(
                    (filePath) => !contextFileSet.has(filePath)
                );
                if (missingInRepo.length > 0) {
                    content = `${content}\n\nNote: Evidence references files not found in the repo index: ${missingInRepo.join(
                        ", "
                    )}.`;
                } else if (missingInContext.length > 0) {
                    content = `${content}\n\nNote: Evidence references files not in retrieved context: ${missingInContext.join(
                        ", "
                    )}.`;
                }
            }
            if (state.domSummary && evidence.selectors.length > 0) {
                const elements = parseSummaryElements(state.domSummary);
                const domSelectors = new Set<string>();
                for (const el of elements) {
                    if (!el.selector) continue;
                    domSelectors.add(el.selector);
                    const normalized = normalizeSelector(el.selector);
                    if (normalized) {
                        domSelectors.add(normalized);
                    }
                }
                if (domSelectors.size > 0) {
                    const missingSelectors = evidence.selectors.filter((selector) => {
                        const normalized = normalizeSelector(selector) || selector;
                        return !domSelectors.has(selector) && !domSelectors.has(normalized);
                    });
                    if (missingSelectors.length > 0) {
                        content = `${content}\n\nNote: Evidence references selectors not found in the DOM summary: ${missingSelectors.join(
                            ", "
                        )}.`;
                    }
                }
            }
        }

        return {
            summary: content || "",
            context,
        };
    };
