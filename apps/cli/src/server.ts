import path from "node:path";
import fastifyStatic from "@fastify/static";
import { appRouter } from "@raiken/shared";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import fastify from "fastify";
import { detectProject } from "./project-detector";
import { runOrchestrator, ProjectContext, CodeGraphDB, EntryPointDetector, CodeGraph, AgentMemory } from "@raiken/core";

export async function startServer(port = 7101) {
    const app = fastify({ logger: true });
    const projectPath = process.cwd();
    
    // Initialize ProjectContext singleton at startup
    // This caches project understanding and persists across requests
    try {
        console.log('🧠 Initializing project context...');
        
        // First, ensure DB has the graph if it's empty
        const db = new CodeGraphDB(projectPath);
        const files = db.getFiles();
        
        if (files.length === 0) {
            // Initial scan needed - build and save to DB
            const graph = new CodeGraph(projectPath, {
                includeTests: false,
                useGitignore: true,
                maxDepth: 15
            });
            
            const detector = new EntryPointDetector(projectPath);
            const entryPoints = await detector.detectEntryPoints();
            
            if (entryPoints.length > 0) {
                console.log(`📍 Found ${entryPoints.length} entry points`);
                await graph.initialize(entryPoints.map(ep => ep.file));
            } else {
                console.log('📂 Scanning entire project...');
                await graph.scanProject();
            }
            
            const allFiles = graph.getAllFiles();
            const nodes = new Map();
            for (const node of allFiles) {
                nodes.set(node.filePath, node);
            }
            
            const dbEntryPoints = entryPoints.map(ep => ({
                file: ep.file,
                framework: ep.framework,
                role: ep.role || 'main',
                type: ep.type
            }));
            
            db.saveGraph(nodes, dbEntryPoints);
            console.log(`✅ Code graph built: ${allFiles.length} files indexed`);
            graph.destroy();
        } else {
            console.log(`✅ Code graph exists: ${files.length} files indexed`);
        }
        
        db.close();
        
        // Now initialize ProjectContext (uses DB + in-memory caching)
        const projectContext = ProjectContext.getInstance(projectPath);
        await projectContext.initialize();
        
        // Log project understanding stats
        const modules = projectContext.getModules();
        if (modules.length > 0) {
            const topModules = modules.slice(0, 5).map(m => m.name);
            console.log(`📁 Modules: ${topModules.join(', ')}`);
        }
        console.log(`🔑 Keywords: ${projectContext.getKeywordCount()}`);
        console.log(`📄 Files: ${projectContext.getFileCount()}`);
        
        // Initialize AgentMemory for persistent learning
        const agentMemory = AgentMemory.getInstance(projectPath);
        agentMemory.initialize();
        
        const prefs = agentMemory.getAllPreferences();
        const prefCount = Object.keys(prefs).length;
        if (prefCount > 0) {
            console.log(`🧠 Memory: ${prefCount} preferences loaded`);
        }
        
    } catch (error) {
        console.warn('⚠️  Failed to initialize project context:', error);
    }

    await app.register(fastifyTRPCPlugin, {
        prefix: "/api/trpc",
        trpcOptions: { 
            router: appRouter,
            createContext: () => ({
                projectPath: process.cwd()
            })
        },
    });

    app.get('/api/project-info', async (request, reply) => {
        try {
            const info = await detectProject(process.cwd());
            return {
                name: info.name,
                cwd: info.rootDir,
                projectType: info.type,
                packageManager: info.packageManager,
                testDir: info.testDir,
                testFramework: info.testFramework,
            };
        } catch (err) {
            request.log?.error?.(err as Error);
            reply.code(500).send({ error: 'failed to detect project', detail: String(err) });
        }
    });

    // AI Test Generation - Server-Sent Events (SSE) endpoint
    app.post('/api/generate-test', async (request, reply) => {
        try {
            const body = request.body as { 
                prompt?: string; 
                fileContext?: string[]; 
                conversationHistory?: Array<{ role: string; content: string }>;
            };
            const { prompt, fileContext, conversationHistory } = body;

            if (!prompt) {
                reply.code(400).send({ error: 'Prompt is required' });
                return;
            }

            // Set SSE headers
            reply.raw.setHeader('Content-Type', 'text/event-stream');
            reply.raw.setHeader('Cache-Control', 'no-cache');
            reply.raw.setHeader('Connection', 'keep-alive');
            reply.raw.setHeader('Access-Control-Allow-Origin', '*');

            request.log.info(`🤖 Generating test for prompt: "${prompt.slice(0, 50)}..."`);
            console.log('💬 Conversation history:', conversationHistory?.length || 0, 'messages');

            try {
                // Route through orchestrator (LLM decides what tools to call)
                const stream = runOrchestrator({
                    userPrompt: prompt,
                    projectPath: process.cwd(),
                    conversationHistory,
                });

                let hasData = false;
                let chunkCount = 0;

                for await (const chunk of stream) {
                    hasData = true;
                    chunkCount++;
                    
                    if (chunkCount <= 3 || chunkCount % 10 === 0) {
                        console.log(`📤 Sending chunk ${chunkCount} to client:`, chunk.slice(0, 50));
                    }
                    
                    // Send chunk as SSE
                    reply.raw.write(`data: ${JSON.stringify({ chunk })}\n\n`);
                }

                if (!hasData) {
                    console.warn('⚠️  No data was streamed');
                    reply.raw.write(`data: ${JSON.stringify({ error: 'No response generated' })}\n\n`);
                }

                console.log(`✅ Streaming complete (${chunkCount} chunks)`);

                // Send completion signal
                reply.raw.write(`data: ${JSON.stringify({ done: true })}\n\n`);
                reply.raw.end();
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.error('❌ Stream error:', errorMessage);
                reply.raw.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
                reply.raw.end();
            }
        } catch (err) {
            request.log?.error?.(err as Error);
            console.error('❌ Request error:', err);
            reply.code(500).send({ 
                error: 'Test generation failed', 
                detail: String(err) 
            });
        }
    });

    const publicDir = path.join(__dirname, "public");

    app.register(fastifyStatic, {
        root: publicDir,
        prefix: "/",
    });

    // SPA fallback: serve index.html for client-side routing
    app.setNotFoundHandler((request, reply) => {
        const isApiRoute = request.url.startsWith('/api');
        if (isApiRoute) {
            reply.code(404).send({ error: 'Not found' });
        } else {
            // Serve index.html for client-side routing
            reply.sendFile('index.html');
        }
    });

    try {
        await app.listen({ port, host: "0.0.0.0" });
        console.log(`\n🚀 Raiken UI running at http://localhost:${port}`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}
