// libs/shared/src/lib/router.ts
import { initTRPC } from "@trpc/server";
import { z } from "zod";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
    EntryPointDetector,
    CodeGraph,
    CodeGraphDB,
    formatBytes,
    EmbeddingsGenerator,
    fullAstToSearchableText,
    writePlaywrightConfig,
    playwrightConfigExists,
    getQuickInterpretation,
} from "@raiken/core";

async function findPlaywrightConfigPath(projectPath: string): Promise<string | null> {
    const candidates = [
        "playwright.config.ts",
        "playwright.config.js",
        "playwright.config.mts",
        "playwright.config.mjs",
        "playwright.config.cjs",
    ];

    for (const name of candidates) {
        const fullPath = path.join(projectPath, name);
        try {
            await fs.access(fullPath);
            return fullPath;
        } catch {
            // continue
        }
    }

    return null;
}

// Context type for tRPC procedures
export interface Context {
  projectPath: string;
}

// In-memory message store (persists until server stops)
interface ChatMessage {
  id: string;
  content: string;
  sender: 'user' | 'assistant';
  timestamp: number;
  fileMentions?: string[];
}

// Store messages per project path
const messageStore: Map<string, ChatMessage[]> = new Map();

function getMessages(projectPath: string): ChatMessage[] {
  return messageStore.get(projectPath) || [];
}

function addMessage(projectPath: string, message: ChatMessage): void {
  const messages = getMessages(projectPath);
  messages.push(message);
  messageStore.set(projectPath, messages);
}

function clearMessages(projectPath: string): void {
  messageStore.set(projectPath, []);
}

const t = initTRPC.context<Context>().create();

export const appRouter = t.router({
    getHealth: t.procedure.query(() => {
        return { 
            status: "ok", 
            engine: "raiken",
            version: "0.0.1"
        };
    }),

    getProjectInfo: t.procedure.query(async ({ ctx }) => {
        return {
            path: ctx.projectPath,
            nodeVersion: process.version,
        };
    }),

    // Chat message persistence endpoints
    getChatMessages: t.procedure.query(({ ctx }) => {
        return { messages: getMessages(ctx.projectPath) };
    }),

    addChatMessage: t.procedure
        .input(
            z.object({
                id: z.string(),
                content: z.string(),
                sender: z.enum(['user', 'assistant']),
                timestamp: z.number(),
                fileMentions: z.array(z.string()).optional(),
            })
        )
        .mutation(({ input, ctx }) => {
            addMessage(ctx.projectPath, input);
            return { success: true, messageCount: getMessages(ctx.projectPath).length };
        }),

    clearChatMessages: t.procedure.mutation(({ ctx }) => {
        clearMessages(ctx.projectPath);
        return { success: true };
    }),

    buildCodeGraph: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
                includeTests: z.boolean().default(true),
                extensions: z.array(z.string()).optional(),
                useGitignore: z.boolean().default(true),
                persist: z.boolean().default(true),
            })
        )
        .mutation(async ({ input }) => {
            const projectPath = input.path || process.cwd();
            // Detect entry points
            const detector = new EntryPointDetector(projectPath);
            const entryPoints = await detector.detectEntryPoints();

            // Build code graph
            const graph = new CodeGraph(projectPath, {
                includeTests: input.includeTests,
                extensions: input.extensions,
                useGitignore: input.useGitignore,
                maxDepth: 15
            });

            // Scan entire project to index all non-binary files
            await graph.scanProject();

            const stats = graph.getStats();
            const allFiles = graph.getAllFiles();

            const totalSize = allFiles.reduce((sum, node) => sum + node.size, 0);
            const totalLines = allFiles.reduce((sum, node) => sum + node.lines, 0);

            // Persist to database if requested
            if (input.persist) {
                const db = new CodeGraphDB(projectPath);
                const nodes = new Map();
                for (const node of allFiles) {
                    nodes.set(node.filePath, node);
                }
                // Map entry points to database format
                const dbEntryPoints = entryPoints.map(ep => ({
                    file: ep.file,
                    framework: ep.framework,
                    role: ep.role || 'main',
                    type: ep.type
                }));
                db.saveGraph(nodes, dbEntryPoints);
                db.close();
            }

            // Return graph structure with linkages
            return {
                projectRoot: projectPath,
                entryPoints: entryPoints.map(ep => ({
                    file: path.relative(projectPath, ep.file),
                    framework: ep.framework,
                    role: ep.role,
                    type: ep.type
                })),
                stats,
                totalSize,
                totalLines,
                totalSizeFormatted: formatBytes(totalSize),
                files: allFiles.map(node => ({
                    path: node.relativePath,
                    depth: node.depth,
                    functions: node.parsed.functions.length,
                    classes: node.parsed.classes.length,
                    types: node.parsed.types.length,
                    size: node.size,
                    lines: node.lines,
                    imports: node.imports.map(imp => path.relative(projectPath, imp)),
                    importedBy: node.importedBy.map(imp => path.relative(projectPath, imp))
                }))
            };
        }),

    getGraphStats: t.procedure
        .input(z.object({
            path: z.string().optional(),
        }))
        .query(async ({ input }) => {
            const projectPath = input.path || process.cwd();
            const db = new CodeGraphDB(projectPath);
            const stats = db.getStats();
            db.close();

            if (!stats) {
                return null;
            }

            return {
                projectPath: stats.project_path,
                totalFiles: stats.total_files,
                totalSize: stats.total_size,
                totalSizeFormatted: formatBytes(stats.total_size),
                totalLines: stats.total_lines,
                totalFunctions: stats.total_functions,
                totalClasses: stats.total_classes,
                totalTypes: stats.total_types,
                lastScan: new Date(stats.last_scan).toISOString(),
            };
        }),

    getGraphFiles: t.procedure
        .input(z.object({
            path: z.string().optional(),
            limit: z.number().default(100),
            offset: z.number().default(0),
        }))
        .query(async ({ input }) => {
            const projectPath = input.path || process.cwd();
            const db = new CodeGraphDB(projectPath);
            const allFiles = db.getFiles();
            db.close();

            const paginated = allFiles.slice(input.offset, input.offset + input.limit);

            return {
                total: allFiles.length,
                files: paginated.map(file => ({
                    path: file.relative_path,
                    size: file.size,
                    sizeFormatted: formatBytes(file.size),
                    lines: file.lines,
                    depth: file.depth,
                    functions: file.functions_count,
                    classes: file.classes_count,
                    types: file.types_count,
                    imports: file.imports_count,
                    exports: file.exported_count,
                    contentHash: file.content_hash,
                    treeHash: file.tree_hash,
                    lastIndexed: new Date(file.last_indexed).toISOString(),
                })),
                hasMore: input.offset + input.limit < allFiles.length,
            };
        }),

    getFileDependencies: t.procedure
        .input(z.object({
            path: z.string().optional(),
            filePath: z.string(),
        }))
        .query(async ({ input }) => {
            const projectPath = input.path || process.cwd();
            const db = new CodeGraphDB(projectPath);
            
            const dependencies = db.getDependencies(path.join(projectPath, input.filePath));
            const dependents = db.getDependents(path.join(projectPath, input.filePath));
            
            db.close();

            return {
                filePath: input.filePath,
                imports: dependencies.map(dep => path.relative(projectPath, dep.target_file)),
                importedBy: dependents.map(dep => path.relative(projectPath, dep.source_file)),
                timestamp: new Date().toISOString()
        };
        }),

    getFileContent: t.procedure
        .input(z.object({
            filePath: z.string(),
        }))
        .query(async ({ input }) => {
            const projectPath = process.cwd();
            const fullPath = path.join(projectPath, input.filePath);
            
            try {
                const fs = await import('node:fs/promises');
                const content = await fs.readFile(fullPath, 'utf-8');
                return {
                    filePath: input.filePath,
                    content,
                    timestamp: new Date().toISOString()
                };
            } catch {
                throw new Error(`Failed to read file: ${input.filePath}`);
            }
        }),

    // ============================================================================
    // Embeddings & Semantic Search Endpoints
    // ============================================================================

    generateEmbeddings: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
                forceRegenerate: z.boolean().default(false),
            })
        )
        .mutation(async ({ input }) => {
            const projectPath = input.path || process.cwd();
            const db = new CodeGraphDB(projectPath);
            const embGen = EmbeddingsGenerator.getInstance();

            try {
                // Initialize model
                await embGen.initialize();

                // Get all files from database
                const files = db.getFiles();
                let totalChunks = 0;
                let filesProcessed = 0;

                console.log(`🔄 Generating embeddings for ${files.length} files...`);

                for (const file of files) {
                    // Skip if embeddings already exist and not forcing regeneration
                    if (!input.forceRegenerate && db.hasEmbeddings(file.id)) {
                        continue;
                    }

                    // Use full AST for richer embeddings (needed for test generation)
                    if (!file.ast) {
                        console.warn(`⚠️  No AST data for ${file.relative_path}, skipping`);
                        continue;
                    }

                    // Parse stored full AST
                    let ast: unknown;
                    try {
                        ast = JSON.parse(file.ast);
                    } catch {
                        console.warn(`⚠️  Failed to parse AST for ${file.relative_path}, skipping`);
                        continue;
                    }

                    // Convert full AST to rich searchable text
                    const searchableText = fullAstToSearchableText(ast, file.relative_path);

                    // Skip if no content
                    if (!searchableText || searchableText.trim().length === 0) {
                        continue;
                    }

                    // For now, embed the entire file as one chunk
                    // Future: Can split into semantic chunks based on AST nodes
                    const chunks = [{
                        type: 'file' as const,
                        name: file.relative_path,
                        text: searchableText,
                    }];

                    // Generate embeddings
                    const texts = chunks.map(c => c.text);
                    const embeddings = await embGen.generateEmbeddingsBatch(texts);

                    // Store in database
                    const chunksWithEmbeddings = chunks.map((chunk, i) => ({
                        ...chunk,
                        embedding: embeddings[i],
                    }));

                    db.saveEmbeddings(file.id, chunksWithEmbeddings);
                    totalChunks += chunks.length;
                    filesProcessed++;

                    if (filesProcessed % 10 === 0) {
                        console.log(`  Progress: ${filesProcessed}/${files.length} files`);
                    }
                }

                db.close();

                return {
                    success: true,
                    filesProcessed,
                    totalFiles: files.length,
                    chunksGenerated: totalChunks,
                    modelUsed: 'Xenova/all-MiniLM-L6-v2',
                    embeddingDimension: 384,
                    timestamp: new Date().toISOString(),
                };
            } catch (error) {
                db.close();
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Unknown error',
                    filesProcessed: 0,
                    totalFiles: 0,
                    chunksGenerated: 0,
                    timestamp: new Date().toISOString(),
                };
            }
        }),

    searchCode: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
                query: z.string(),
                limit: z.number().default(10),
                chunkTypes: z.array(z.enum(['function', 'class', 'file', 'type'])).optional(),
            })
        )
        .query(async ({ input }) => {
            const projectPath = input.path || process.cwd();
            const db = new CodeGraphDB(projectPath);
            const embGen = EmbeddingsGenerator.getInstance();

            try {
                // Check if embeddings exist
                const embeddingsCount = db.getEmbeddingsCount();
                if (embeddingsCount === 0) {
                    db.close();
                    return {
                        query: input.query,
                        results: [],
                        message: 'No embeddings found. Please run generateEmbeddings first.',
                        timestamp: new Date().toISOString(),
                    };
                }

                // Generate embedding for query
                await embGen.initialize();
                const queryEmbedding = await embGen.generateEmbedding(input.query);

                // Search database
                const results = db.searchSimilar(
                    queryEmbedding,
                    input.limit,
                    input.chunkTypes
                );

                db.close();

                return {
                    query: input.query,
                    results: results.map(r => ({
                        filePath: r.filePath,
                        chunkType: r.chunkType,
                        chunkName: r.chunkName,
                        chunkText: r.chunkText,
                        similarity: r.similarity,
                        relevanceScore: Math.round(r.similarity * 100),
                    })),
                    totalResults: results.length,
                    timestamp: new Date().toISOString(),
                };
            } catch (error) {
                db.close();
                return {
                    query: input.query,
                    results: [],
                    error: error instanceof Error ? error.message : 'Unknown error',
                    timestamp: new Date().toISOString(),
                };
            }
        }),

    getEmbeddingsStats: t.procedure
        .input(z.object({
            path: z.string().optional(),
        }))
        .query(async ({ input }) => {
            const projectPath = input.path || process.cwd();
            const db = new CodeGraphDB(projectPath);
            
            const totalEmbeddings = db.getEmbeddingsCount();
            const totalFiles = db.getStats()?.total_files || 0;
            
            db.close();

            return {
                totalEmbeddings,
                totalFiles,
                embeddingsPerFile: totalFiles > 0 ? (totalEmbeddings / totalFiles).toFixed(2) : '0',
                modelUsed: 'Xenova/all-MiniLM-L6-v2',
                embeddingDimension: 384,
                timestamp: new Date().toISOString(),
            };
        }),

    saveGeneratedTest: t.procedure
        .input(
            z.object({
                fileName: z.string(),
                content: z.string(),
                testDir: z.string().optional(),
            })
        )
        .mutation(async ({ input, ctx }) => {
            const { fileName, testDir: customTestDir } = input;
            let { content } = input;

            // Strip markdown code fences if present
            // Matches ```typescript, ```ts, ```javascript, ```js, or just ```
            content = content.replace(/^```(?:typescript|ts|javascript|js)?\s*\n?/i, '');
            content = content.replace(/\n?```\s*$/i, '');
            content = content.trim();

            // Load test directory from raiken.config.json if exists
            let testDirectory = customTestDir || 'e2e';
            const configPath = path.join(ctx.projectPath, 'raiken.config.json');
            
            try {
                const configContent = await fs.readFile(configPath, 'utf-8');
                const config = JSON.parse(configContent);
                testDirectory = config.testDirectory || testDirectory;
            } catch {
                // Use default or provided testDir
            }

            // Validate filename
            if (!fileName.match(/^[a-zA-Z0-9_-]+\.(spec|test)\.(ts|tsx|js|jsx)$/)) {
                throw new Error('Invalid filename. Must be a test file (*.spec.ts, *.test.tsx, etc.)');
            }

            // Prevent directory traversal
            if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
                throw new Error('Filename must not contain path separators or parent directory references');
            }

            // Create test directory if it doesn't exist
            const testDirPath = path.join(ctx.projectPath, testDirectory);
            await fs.mkdir(testDirPath, { recursive: true });

            // Write the test file
            const filePath = path.join(testDirPath, fileName);
            await fs.writeFile(filePath, content, 'utf-8');

            console.log(`✓ Saved generated test: ${path.relative(ctx.projectPath, filePath)}`);

            return {
                success: true,
                filePath: path.relative(ctx.projectPath, filePath),
                absolutePath: filePath,
            };
        }),

    // List test files from the filesystem (not from code graph)
    listTestFiles: t.procedure
        .input(
            z.object({
                testDir: z.string().optional(),
            })
        )
        .query(async ({ input, ctx }) => {
            // Load test directory from raiken.config.json if exists
            let testDirectory = input.testDir || 'e2e';
            const configPath = path.join(ctx.projectPath, 'raiken.config.json');
            
            try {
                const configContent = await fs.readFile(configPath, 'utf-8');
                const config = JSON.parse(configContent);
                testDirectory = config.testDirectory || testDirectory;
            } catch {
                // Use default or provided testDir
            }

            const testDirPath = path.join(ctx.projectPath, testDirectory);
            const testFiles: Array<{ name: string; path: string; directory: string }> = [];

            // Check if test directory exists
            try {
                await fs.access(testDirPath);
            } catch {
                // Directory doesn't exist, return empty array
                return { files: testFiles, testDirectory };
            }

            // Recursively scan for test files
            async function scanDir(dirPath: string, relativePath = '') {
                try {
                    const entries = await fs.readdir(dirPath, { withFileTypes: true });
                    
                    for (const entry of entries) {
                        const entryPath = path.join(dirPath, entry.name);
                        const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
                        
                        if (entry.isDirectory()) {
                            await scanDir(entryPath, entryRelPath);
                        } else if (entry.isFile()) {
                            // Check if it's a test file
                            if (/\.(test|spec|e2e)\.(ts|tsx|js|jsx)$/.test(entry.name)) {
                                testFiles.push({
                                    name: entry.name,
                                    path: `${testDirectory}/${entryRelPath}`,
                                    directory: testDirectory + (relativePath ? `/${relativePath}` : ''),
                                });
                            }
                        }
                    }
                } catch (error) {
                    console.error(`Error scanning directory ${dirPath}:`, error);
                }
            }

            await scanDir(testDirPath);

            return { files: testFiles, testDirectory };
        }),

    // Run Playwright tests with performance options
    runTests: t.procedure
        .input(
            z.object({
                testFile: z.string().optional(), // Specific file to run, or all if not provided
                testName: z.string().optional(), // Specific test name to run
                parallel: z.boolean().default(true), // Run tests in parallel
                workers: z.number().optional(), // Number of workers (auto if not specified)
            })
        )
        .mutation(async ({ input, ctx }) => {
            const { spawn } = await import('node:child_process');
            
            return new Promise((resolve) => {
                const args = ['test'];
                const configPathPromise = findPlaywrightConfigPath(ctx.projectPath);
                
                // Add specific test file if provided
                if (input.testFile) {
                    args.push(input.testFile);
                }
                
                // Add test name filter if provided
                if (input.testName) {
                    args.push('-g', input.testName);
                }
                
                // Performance options - only add workers if explicitly set to a number
                // Omitting --workers flag lets Playwright auto-detect
                if (input.workers !== undefined && typeof input.workers === 'number') {
                    args.push(`--workers=${input.workers}`);
                }
                // Note: for auto detection, we don't pass --workers at all
                
                // Add reporter for structured output
                args.push('--reporter=json');
                
                console.log(`🧪 Running tests: npx playwright ${args.join(' ')}`);
                
                void configPathPromise.then(configPath => {
                    if (configPath) {
                        args.push('--config', configPath);
                    }

                    console.log(`🧪 Using config: ${configPath || 'default (playwright.config.* if present)'}`);

                    const testProcess = spawn('npx', ['playwright', ...args], {
                        cwd: ctx.projectPath,
                        shell: true,
                        env: { ...process.env, FORCE_COLOR: '0' },
                    });
                
                    let stdout = '';
                    let stderr = '';
                
                    testProcess.stdout?.on('data', (data) => {
                        stdout += data.toString();
                    });
                
                    testProcess.stderr?.on('data', (data) => {
                        stderr += data.toString();
                    });
                
                    testProcess.on('close', (code) => {
                        console.log(`🧪 Tests completed with exit code: ${code}`);
                    
                        // Try to parse JSON output
                        let results = null;
                        try {
                            // Find the JSON part in the output
                            const jsonMatch = stdout.match(/\{[\s\S]*\}/);
                            if (jsonMatch) {
                                results = JSON.parse(jsonMatch[0]);
                            }
                        } catch {
                            // JSON parsing failed, use raw output
                        }
                    
                        resolve({
                            success: code === 0,
                            exitCode: code,
                            stdout,
                            stderr,
                            results,
                        });
                    });
                
                    testProcess.on('error', (error) => {
                        console.error('🧪 Test execution error:', error);
                        resolve({
                            success: false,
                            exitCode: -1,
                            stdout: '',
                            stderr: error.message,
                            results: null,
                        });
                    });
                });
            });
        }),

    // Generate optimized Playwright configuration
    generatePlaywrightConfig: t.procedure
        .input(
            z.object({
                baseURL: z.string(),
                testDir: z.string().optional(),
                parallel: z.boolean().optional(),
                workers: z.union([z.number(), z.literal('auto')]).optional(),
                retries: z.number().optional(),
                timeout: z.number().optional(),
            })
        )
        .mutation(async ({ input, ctx }) => {
            // Check if config already exists
            const exists = await playwrightConfigExists(ctx.projectPath);
            if (exists) {
                return {
                    success: false,
                    path: '',
                    message: 'playwright.config.ts already exists. Delete it first if you want to regenerate.',
                    exists: true,
                };
            }
            
            const result = await writePlaywrightConfig(ctx.projectPath, {
                baseURL: input.baseURL,
                testDir: input.testDir,
                parallel: input.parallel,
                workers: input.workers,
                retries: input.retries,
                timeout: input.timeout,
            });
            
            return {
                ...result,
                exists: false,
            };
        }),

    // Check if Playwright config exists
    checkPlaywrightConfig: t.procedure
        .query(async ({ ctx }) => {
            const exists = await playwrightConfigExists(ctx.projectPath);
            return { exists };
        }),

    // Interpret test results using AI
    interpretTestResults: t.procedure
        .input(
            z.object({
                testResults: z.array(z.object({
                    name: z.string(),
                    suite: z.string(),
                    status: z.enum(['passed', 'failed', 'skipped']),
                    duration: z.number().optional(),
                    error: z.object({
                        message: z.string().optional(),
                        snippet: z.string().optional(),
                        location: z.object({
                            file: z.string(),
                            line: z.number(),
                            column: z.number(),
                        }).optional(),
                    }).optional(),
                })),
                testCode: z.string(),
                sourceCode: z.string().optional(),
                domContext: z.object({
                    url: z.string(),
                    title: z.string(),
                    interactiveElements: z.array(z.object({
                        tagName: z.string(),
                        role: z.string().optional(),
                        name: z.string().optional(),
                        text: z.string().optional(),
                        testId: z.string().optional(),
                        suggestedSelectors: z.array(z.string()),
                    })),
                    formFields: z.array(z.object({
                        name: z.string(),
                        type: z.string(),
                        label: z.string().optional(),
                        placeholder: z.string().optional(),
                        required: z.boolean(),
                        suggestedSelector: z.string(),
                    })),
                }).optional(),
            })
        )
        .mutation(async ({ input, ctx }) => {
            const apiKey = process.env['OPENROUTER_API_KEY'];
            if (!apiKey) {
                return { interpretation: 'Error: OPENROUTER_API_KEY not configured.', error: true };
            }

            try {
                const context = {
                    testResults: input.testResults,
                    testCode: input.testCode,
                    sourceCode: input.sourceCode,
                    domContext: input.domContext as any, // eslint-disable-line @typescript-eslint/no-explicit-any
                    projectPath: ctx.projectPath,
                };

                const interpretation = await getQuickInterpretation(context, { apiKey });
                return { interpretation, error: false };
            } catch (error) {
                console.error('Interpretation error:', error);
                return {
                    interpretation: `Error interpreting results: ${error instanceof Error ? error.message : String(error)}`,
                    error: true
                };
            }
        }),

    // ============================================================================
    // Site Discovery Endpoints
    // ============================================================================

    getDiscoveryStats: t.procedure
        .input(z.object({
            path: z.string().optional(),
        }))
        .query(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            const db = new CodeGraphDB(projectPath);

            try {
                const { SiteKnowledgeDB } = await import('@raiken/core');
                const siteDb = new SiteKnowledgeDB((db as any).db, projectPath);
                const stats = siteDb.getStats();
                db.close();

                return {
                    ...stats,
                    timestamp: new Date().toISOString(),
                };
            } catch (error) {
                db.close();
                return {
                    pagesCount: 0,
                    linksCount: 0,
                    verifiedLinksCount: 0,
                    brokenLinksCount: 0,
                    authBlockersCount: 0,
                    unresolvedBlockersCount: 0,
                    timestamp: new Date().toISOString(),
                };
            }
        }),

    getDiscoverySession: t.procedure
        .input(z.object({
            path: z.string().optional(),
        }))
        .query(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            const db = new CodeGraphDB(projectPath);

            try {
                const { SiteKnowledgeDB } = await import('@raiken/core');
                const siteDb = new SiteKnowledgeDB((db as any).db, projectPath);
                const session = siteDb.getLatestSession();
                db.close();

                if (!session) {
                    return null;
                }

                return {
                    id: session.id,
                    startUrl: session.startUrl,
                    status: session.status,
                    pagesDiscovered: session.pagesDiscovered,
                    linksFound: session.linksFound,
                    startedAt: new Date(session.startedAt).toISOString(),
                    completedAt: session.completedAt ? new Date(session.completedAt).toISOString() : null,
                    blockedAtUrl: session.blockedAtUrl,
                };
            } catch (error) {
                db.close();
                return null;
            }
        }),

    getDiscoveredPages: t.procedure
        .input(z.object({
            path: z.string().optional(),
            limit: z.number().default(50),
        }))
        .query(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            const db = new CodeGraphDB(projectPath);

            try {
                const { SiteKnowledgeDB } = await import('@raiken/core');
                const siteDb = new SiteKnowledgeDB((db as any).db, projectPath);
                const pages = siteDb.getAllPages();
                db.close();

                const limited = pages.slice(0, input.limit);

                return {
                    pages: limited.map(page => ({
                        url: page.url,
                        title: page.title,
                        depth: page.depth,
                        visitCount: page.visitCount,
                        discoveredAt: new Date(page.discoveredAt).toISOString(),
                        lastVisitedAt: new Date(page.lastVisitedAt).toISOString(),
                    })),
                    total: pages.length,
                    hasMore: pages.length > input.limit,
                };
            } catch (error) {
                db.close();
                return {
                    pages: [],
                    total: 0,
                    hasMore: false,
                };
            }
        }),

    getAuthBlockers: t.procedure
        .input(z.object({
            path: z.string().optional(),
        }))
        .query(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            const db = new CodeGraphDB(projectPath);

            try {
                const { SiteKnowledgeDB } = await import('@raiken/core');
                const siteDb = new SiteKnowledgeDB((db as any).db, projectPath);
                const blockers = siteDb.getUnresolvedBlockers();
                db.close();

                return {
                    blockers: blockers.map(blocker => ({
                        id: blocker.id,
                        url: blocker.url,
                        blockerType: blocker.blockerType,
                        discoveredAt: new Date(blocker.discoveredAt).toISOString(),
                    })),
                    total: blockers.length,
                };
            } catch (error) {
                db.close();
                return {
                    blockers: [],
                    total: 0,
                };
            }
        }),

    clearDiscoveryData: t.procedure
        .input(z.object({
            path: z.string().optional(),
        }))
        .mutation(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            const db = new CodeGraphDB(projectPath);

            try {
                const { SiteKnowledgeDB } = await import('@raiken/core');
                const siteDb = new SiteKnowledgeDB((db as any).db, projectPath);
                siteDb.clearDiscoveryData();
                db.close();

                return {
                    success: true,
                    message: 'Discovery data cleared successfully',
                };
            } catch (error) {
                db.close();
                return {
                    success: false,
                    message: error instanceof Error ? error.message : 'Unknown error',
                };
            }
        }),
});

// Export the Type to be shared
export type AppRouter = typeof appRouter;
