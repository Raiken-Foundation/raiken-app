import * as crypto from "node:crypto";
import type Database from "better-sqlite3";
import type {
    CodeNode,
    DBDependency,
    DBEntryPoint,
    DBFileNode,
    DBStats,
    EdgeKind,
    GraphEdge,
    ParsedSymbol,
    SymbolKind,
} from "../types";
import type { DbAdapter } from "./adapter";
import { closeDatabase, openDatabase, vacuumDatabase } from "./connection";
import { SCHEMA_VERSION } from "./constants";
import { AdminRepository } from "./repositories/admin.repository";
import { CodeGraphRepository } from "./repositories/code-graph.repository";
import { EmbeddingsRepository } from "./repositories/embeddings.repository";
import { MemoryRepository } from "./repositories/memory.repository";
import { SymbolsRepository } from "./repositories/symbols.repository";
import { TestOutcomesRepository } from "./repositories/test-outcomes.repository";

export { DatabaseError } from "./errors";

/**
 * Database layer for persisting CodeGraph data.
 *
 * FEATURES:
 * - SQLite with WAL mode for performance
 * - Schema versioning with migrations
 * - Full AST persistence (can reconstruct graph)
 * - Incremental updates (only changed files)
 * - Retry logic for busy database
 * - Streaming for large datasets
 *
 * SCHEMA VERSION: 6
 */
export class CodeGraphDB {
    private readonly adapter: DbAdapter;
    private readonly dbPath: string;
    private readonly projectPath: string;

    private readonly codeGraph: CodeGraphRepository;
    private readonly embeddingsRepo: EmbeddingsRepository;
    private readonly memory: MemoryRepository;
    private readonly testOutcomes: TestOutcomesRepository;
    private readonly symbols: SymbolsRepository;
    private readonly admin: AdminRepository;

    constructor(projectPath: string, dbPath?: string) {
        const opened = openDatabase(projectPath, dbPath);
        this.adapter = opened.adapter;
        this.dbPath = opened.dbPath;
        this.projectPath = opened.projectPath;

        this.symbols = new SymbolsRepository(this.adapter);
        this.embeddingsRepo = new EmbeddingsRepository(this.adapter);
        this.codeGraph = new CodeGraphRepository(this.adapter, this.symbols);
        this.memory = new MemoryRepository(this.adapter);
        this.testOutcomes = new TestOutcomesRepository(this.adapter);
        this.admin = new AdminRepository(this.adapter);
    }

    getRawDatabase(): Database.Database {
        return this.adapter.db;
    }

    saveGraph(
        nodes: Map<string, CodeNode>,
        entryPoints: Array<{ file: string; framework?: string; role: string; type: string }>,
        indexedVia: "scan" | "watch" = "scan",
    ): { skippedFiles: Array<{ path: string; reason: string }> } {
        return this.codeGraph.saveGraph(nodes, entryPoints, indexedVia);
    }

    upsertFile(node: CodeNode, indexedVia: "scan" | "watch" = "watch"): void {
        this.codeGraph.upsertFile(node, indexedVia);
    }

    removeFile(filePath: string): void {
        this.codeGraph.removeFile(filePath);
    }

    loadGraph(): { nodes: Map<string, CodeNode>; entryPoints: DBEntryPoint[] } | null {
        return this.codeGraph.loadGraph();
    }

    getStats(): DBStats | null {
        return this.codeGraph.getStats();
    }

    getFiles(): DBFileNode[] {
        return this.codeGraph.getFiles();
    }

    *streamFiles(): Generator<DBFileNode> {
        yield* this.codeGraph.streamFiles();
    }

    getFile(filePath: string): DBFileNode | null {
        return this.codeGraph.getFile(filePath);
    }

    getFileByRelativePath(relativePath: string): DBFileNode | null {
        return this.codeGraph.getFileByRelativePath(relativePath);
    }

    getDependencies(filePath: string): DBDependency[] {
        return this.codeGraph.getDependencies(filePath);
    }

    getDependents(filePath: string): DBDependency[] {
        return this.codeGraph.getDependents(filePath);
    }

    getEntryPoints(): DBEntryPoint[] {
        return this.codeGraph.getEntryPoints();
    }

    hasFile(filePath: string): boolean {
        return this.codeGraph.hasFile(filePath);
    }

    hasFileChanged(filePath: string, newHash: string): boolean {
        return this.codeGraph.hasFileChanged(filePath, newHash);
    }

    clearProject(): void {
        this.codeGraph.clearProject();
    }

    getTables(): Array<{ name: string; row_count: number }> {
        return this.admin.getTables();
    }

    getTableCount(tableName: string): number {
        return this.admin.getTableCount(tableName);
    }

    queryTable(tableName: string, limit: number, offset: number): unknown[] {
        return this.admin.queryTable(tableName, limit, offset);
    }

    executeQuery(query: string, params: unknown[] = []): unknown[] {
        return this.admin.executeQuery(query, params);
    }

    saveEmbeddings(
        fileId: number,
        chunks: Array<{
            type: "function" | "class" | "file" | "type";
            name: string;
            text: string;
            embedding: number[];
        }>,
    ): void {
        this.embeddingsRepo.saveEmbeddings(fileId, chunks);
    }

    searchSimilar(
        queryEmbedding: number[],
        limit = 10,
        chunkTypes?: Array<"function" | "class" | "file" | "type">,
    ): Array<{
        fileId: number;
        filePath: string;
        chunkType: string;
        chunkName: string;
        chunkText: string;
        similarity: number;
    }> {
        return this.embeddingsRepo.searchSimilar(queryEmbedding, limit, chunkTypes);
    }

    getFileEmbeddings(fileId: number): Array<{
        id: number;
        chunkType: string;
        chunkName: string;
        chunkText: string;
        createdAt: number;
    }> {
        return this.embeddingsRepo.getFileEmbeddings(fileId);
    }

    deleteFileEmbeddings(fileId: number): void {
        this.embeddingsRepo.deleteFileEmbeddings(fileId);
    }

    getEmbeddingsCount(): number {
        return this.embeddingsRepo.getEmbeddingsCount();
    }

    getFileId(filePath: string): number | null {
        return this.embeddingsRepo.getFileId(filePath);
    }

    hasEmbeddings(fileId: number): boolean {
        return this.embeddingsRepo.hasEmbeddings(fileId);
    }

    saveKeywordIndex(index: Map<string, string[]>): void {
        this.embeddingsRepo.saveKeywordIndex(index);
    }

    loadKeywordIndex(): Map<string, string[]> | null {
        return this.embeddingsRepo.loadKeywordIndex();
    }

    getChangedFilesSince(sinceTimestamp: number): Array<{
        path: string;
        lastIndexed: number;
        contentHash: string;
    }> {
        return this.codeGraph.getChangedFilesSince(sinceTimestamp);
    }

    getLastScanTime(): number {
        return this.codeGraph.getLastScanTime();
    }

    setPreference(key: string, value: string): void {
        this.memory.setPreference(key, value);
    }

    getPreference(key: string): string | null {
        return this.memory.getPreference(key);
    }

    getAllPreferences(): Record<string, string> {
        return this.memory.getAllPreferences();
    }

    recordSelectorSuccess(
        elementDescription: string,
        selector: string,
        selectorType: string,
    ): void {
        this.memory.recordSelectorSuccess(elementDescription, selector, selectorType);
    }

    recordSelectorFailure(
        elementDescription: string,
        selector: string,
        selectorType = "other",
    ): void {
        this.memory.recordSelectorFailure(elementDescription, selector, selectorType);
    }

    getBestSelector(
        elementDescription: string,
    ): { selector: string; selectorType: string; confidence: number } | null {
        return this.memory.getBestSelector(elementDescription);
    }

    getSuccessfulSelectors(
        limit = 20,
    ): Array<{ element: string; selector: string; type: string; confidence: number }> {
        return this.memory.getSuccessfulSelectors(limit);
    }

    getDominantSelectorType(): { type: string; successCount: number } | null {
        return this.memory.getDominantSelectorType();
    }

    recordTestGenerated(
        testFile: string,
        testName: string,
        sourcePrompt: string,
        generatedCode: string,
    ): number {
        return this.testOutcomes.recordTestGenerated(
            testFile,
            testName,
            sourcePrompt,
            generatedCode,
        );
    }

    recordTestResult(
        testId: number,
        status: "passed" | "failed" | "error" | "timeout",
        executionTimeMs?: number,
        errorMessage?: string,
        failingSelector?: string,
    ): void {
        this.testOutcomes.recordTestResult(
            testId,
            status,
            executionTimeMs,
            errorMessage,
            failingSelector,
        );
    }

    upsertRunOutcome(input: {
        testFile: string;
        testName: string;
        status: "passed" | "failed" | "error" | "timeout";
        executionTimeMs?: number;
        errorMessage?: string;
        failingSelector?: string;
    }): void {
        this.testOutcomes.upsertRunOutcome(input);
    }

    getRecentFailures(limit = 10): Array<{
        id: number;
        testFile: string;
        testName: string;
        errorMessage: string | null;
        failingSelector: string | null;
        lastRun: number;
    }> {
        return this.testOutcomes.getRecentFailures(limit);
    }

    getTestOutcome(testId: number): {
        id: number;
        testFile: string;
        testName: string;
        sourcePrompt: string;
        generatedCode: string;
        status: string;
        errorMessage: string | null;
    } | null {
        return this.testOutcomes.getTestOutcome(testId);
    }

    getLatestTestOutcomeId(testFile: string): number | null {
        return this.testOutcomes.getLatestTestOutcomeId(testFile);
    }

    getLatestOutcomesPerFile(): Map<
        string,
        { status: string; lastRun: number | null; createdAt: number }
    > {
        return this.testOutcomes.getLatestOutcomesPerFile();
    }

    getSourceFilesForTest(testFile: string): string[] {
        return this.testOutcomes.getSourceFilesForTest(testFile);
    }

    recordTestSourceFiles(testFile: string, sourceFiles: string[]): void {
        this.testOutcomes.recordTestSourceFiles(testFile, sourceFiles);
    }

    renameTestRecords(rawOldTestFile: string, rawNewTestFile: string): void {
        this.testOutcomes.renameTestRecords(rawOldTestFile, rawNewTestFile);
    }

    deleteTestRecords(testFile: string): void {
        this.testOutcomes.deleteTestRecords(testFile);
    }

    getAffectedTests(changedSourceFiles: string[]): Array<{
        testFile: string;
        reason: "source_map" | "dependency";
        sourceFile: string;
    }> {
        return this.testOutcomes.getAffectedTests(changedSourceFiles);
    }

    replaceFileSymbols(filePath: string, symbols: ParsedSymbol[]): void {
        this.symbols.replaceFileSymbols(filePath, symbols);
    }

    getFileSymbols(filePath: string): ParsedSymbol[] {
        return this.symbols.getFileSymbols(filePath);
    }

    findSymbolsByName(
        name: string,
        opts?: { kinds?: SymbolKind[]; like?: boolean; limit?: number },
    ): Array<{
        file: string;
        symbol: ParsedSymbol;
    }> {
        return this.symbols.findSymbolsByName(name, opts);
    }

    replaceFileEdges(sourceFile: string, edges: GraphEdge[], kinds?: EdgeKind[]): void {
        this.symbols.replaceFileEdges(sourceFile, edges, kinds);
    }

    addEdges(edges: GraphEdge[]): void {
        this.symbols.addEdges(edges);
    }

    getIncomingEdges(targetFiles: string[], opts?: { kinds?: EdgeKind[] }): GraphEdge[] {
        return this.symbols.getIncomingEdges(targetFiles, opts);
    }

    getSymbolGraphStats(): { symbols: number; edges: number; edgesByKind: Record<string, number> } {
        return this.symbols.getSymbolGraphStats();
    }

    close(): void {
        closeDatabase(this.adapter.db);
    }

    getInfo(): { path: string; version: number; projectPath: string } {
        return {
            path: this.dbPath,
            version: SCHEMA_VERSION,
            projectPath: this.projectPath,
        };
    }

    vacuum(): void {
        vacuumDatabase(this.adapter.db);
    }

    pruneHistory(maxSelectors = 500, maxOutcomes = 200): void {
        this.memory.pruneSelectorHistory(maxSelectors);
        this.testOutcomes.pruneTestOutcomes(maxOutcomes);
    }

    static hashContent(content: string): string {
        return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
    }
}
