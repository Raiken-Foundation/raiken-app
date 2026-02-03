import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { load as loadSqliteVec } from 'sqlite-vec';
import type { CodeNode, ParsedFile } from '../types';
import type { DBEntryPoint, DBFileNode, DBDependency, DBStats } from '../types';

// ============================================================================
// Custom Errors
// ============================================================================

export class DatabaseError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'DatabaseError';
  }
}

// ============================================================================
// CodeGraphDB - SQLite Persistence Layer
// ============================================================================

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
 * SCHEMA VERSION: 2
 */
export class CodeGraphDB {
  private db: Database.Database;
  private projectPath: string;
  private readonly dbPath: string;
  
  private static readonly SCHEMA_VERSION = 3;
  private static readonly RETRY_ATTEMPTS = 3;
  private static readonly RETRY_DELAY_MS = 100;

  constructor(projectPath: string, dbPath?: string) {
    this.projectPath = path.resolve(projectPath);
    
    // Default: .raiken/raiken.db in project root
    const defaultDbPath = path.join(this.projectPath, '.raiken', 'raiken.db');
    this.dbPath = dbPath || defaultDbPath;
    
    try {
      // Ensure directory exists
      const dbDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
      
      this.db = new Database(this.dbPath);
      
      // ✅ Load sqlite-vec extension for vector similarity search
      try {
      loadSqliteVec(this.db);
      } catch (error) {
        throw new DatabaseError(
          'Failed to load sqlite-vec extension. Ensure dependencies are installed for your platform and reinstall after Node upgrades.',
          error as Error
        );
      }
      
      // ✅ Enable WAL mode for better concurrency
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('synchronous = NORMAL'); 
      this.db.pragma('wal_autocheckpoint = 5000');

      // ✅ Run migrations
      this.migrateSchema();
      
      // ✅ Ensure .gitignore includes .raiken/
      this.ensureGitignore();
      
    } catch (error) {
      if (error instanceof DatabaseError) {
        throw error;
      }
      throw new DatabaseError(
        `Failed to initialize CodeGraphDB at ${this.dbPath}: ${(error as Error).message}`,
        error as Error
      );
    }
  }

  // ==========================================================================
  // Schema Management
  // ==========================================================================

  private getUserVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number;
  }

  private setUserVersion(version: number): void {
    this.db.pragma(`user_version = ${version}`);
  }

  /**
   * Run schema migrations based on current version.
   */
  private migrateSchema(): void {
    const currentVersion = this.getUserVersion();
    
    if (currentVersion === 0) {
      this.createV1Schema();
      this.setUserVersion(1);
    }
    
    if (this.getUserVersion() === 1) {
      this.migrateToV2();
      this.setUserVersion(2);
    }
    
    if (this.getUserVersion() === 2) {
      this.migrateToV3();
      this.setUserVersion(3);
    }
    
    // Future migrations go here...
  }

  /**
   * Initial schema (v1)
   */
  private createV1Schema(): void {
    this.db.exec(`
      -- Files table with full AST storage
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        tree_hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        lines INTEGER NOT NULL,
        depth INTEGER NOT NULL,
        last_indexed INTEGER NOT NULL,
        functions_count INTEGER DEFAULT 0,
        classes_count INTEGER DEFAULT 0,
        types_count INTEGER DEFAULT 0,
        imports_count INTEGER DEFAULT 0,
        exported_count INTEGER DEFAULT 0,
        parsed_ast TEXT DEFAULT '{}',
        ast TEXT DEFAULT NULL,
        indexed_via TEXT DEFAULT 'scan' CHECK(indexed_via IN ('scan', 'watch')),
        UNIQUE(project_path, file_path)
      );
      
      CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_path);
      CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);
      CREATE INDEX IF NOT EXISTS idx_files_indexed ON files(last_indexed);
      CREATE INDEX IF NOT EXISTS idx_files_indexed_via ON files(indexed_via);
      
      -- Dependencies table (import graph edges)
      CREATE TABLE IF NOT EXISTS dependencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_path TEXT NOT NULL,
        source_file TEXT NOT NULL,
        target_file TEXT NOT NULL,
        import_type TEXT DEFAULT 'static' CHECK(import_type IN ('static', 'dynamic', 'type-only')),
        created_at INTEGER NOT NULL,
        UNIQUE(project_path, source_file, target_file)
      );
      
      CREATE INDEX IF NOT EXISTS idx_deps_project ON dependencies(project_path);
      CREATE INDEX IF NOT EXISTS idx_deps_source ON dependencies(source_file);
      CREATE INDEX IF NOT EXISTS idx_deps_target ON dependencies(target_file);
      
      -- Entry points table
      CREATE TABLE IF NOT EXISTS entry_points (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        framework TEXT,
        role TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(project_path, file_path)
      );
      
      CREATE INDEX IF NOT EXISTS idx_entrypoints_project ON entry_points(project_path);
      
      -- Stats table (project-level metadata)
      CREATE TABLE IF NOT EXISTS stats (
        project_path TEXT PRIMARY KEY,
        total_files INTEGER NOT NULL,
        total_size INTEGER NOT NULL,
        total_lines INTEGER NOT NULL,
        total_functions INTEGER NOT NULL,
        total_classes INTEGER NOT NULL,
        total_types INTEGER NOT NULL,
        last_scan INTEGER NOT NULL,
        schema_version INTEGER DEFAULT 1
      );
    `);
  }

  /**
   * Migration from v1 to v2
   */
  private migrateToV2(): void {
    // Check if columns already exist (in case of partial migration)
    const tableInfo = this.db.prepare(`PRAGMA table_info(files)`).all() as Array<{ name: string }>;
    const columnNames = tableInfo.map(col => col.name);
    
    this.db.transaction(() => {
      // Add parsed_ast column if missing
      if (!columnNames.includes('parsed_ast')) {
        this.db.exec(`ALTER TABLE files ADD COLUMN parsed_ast TEXT DEFAULT '{}'`);
      }
      
      // Add indexed_via column if missing
      if (!columnNames.includes('indexed_via')) {
        this.db.exec(`ALTER TABLE files ADD COLUMN indexed_via TEXT DEFAULT 'scan'`);
      }
      
      // Add import_type to dependencies if missing
      const depsInfo = this.db.prepare(`PRAGMA table_info(dependencies)`).all() as Array<{ name: string }>;
      if (!depsInfo.some(col => col.name === 'import_type')) {
        this.db.exec(`ALTER TABLE dependencies ADD COLUMN import_type TEXT DEFAULT 'static'`);
      }
      
      // Update stats schema_version
      this.db.exec(`
        UPDATE stats SET schema_version = 2 WHERE schema_version IS NULL OR schema_version < 2
      `);
    })();
  }

  /**
   * Migration from v2 to v3 - Add embeddings support
   */
  private migrateToV3(): void {
    this.db.transaction(() => {
      // Create embeddings table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS embeddings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_id INTEGER NOT NULL,
          chunk_type TEXT NOT NULL CHECK(chunk_type IN ('function', 'class', 'file', 'type')),
          chunk_name TEXT NOT NULL,
          chunk_text TEXT NOT NULL,
          embedding BLOB NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_embeddings_file ON embeddings(file_id);
        CREATE INDEX IF NOT EXISTS idx_embeddings_type ON embeddings(chunk_type);
        CREATE INDEX IF NOT EXISTS idx_embeddings_name ON embeddings(chunk_name);
      `);

      // Create virtual table for vector search using sqlite-vec
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
          embedding float[384]
        );
      `);

      // Update stats schema_version
      this.db.exec(`
        UPDATE stats SET schema_version = 3 WHERE schema_version < 3
      `);
    })();
  }

  /**
   * Ensure .raiken/ is in .gitignore
   */
  private ensureGitignore(): void {
    const gitignorePath = path.join(this.projectPath, '.gitignore');
    const entry = '.raiken/';
    
    try {
      if (fs.existsSync(gitignorePath)) {
        const content = fs.readFileSync(gitignorePath, 'utf-8');
        if (!content.includes(entry)) {
          fs.appendFileSync(gitignorePath, `\n# Raiken analysis cache\n${entry}\n`);
        }
      }
    } catch {
      // Ignore gitignore errors - not critical
    }
  }

  // ==========================================================================
  // Retry Logic
  // ==========================================================================

  /**
   * Execute with retry logic for SQLITE_BUSY errors
   */
  private runWithRetry<T>(fn: () => T, retries = CodeGraphDB.RETRY_ATTEMPTS): T {
    try {
      return fn();
    } catch (error: unknown) {
      const sqliteError = error as { code?: string };
      if (sqliteError.code === 'SQLITE_BUSY' && retries > 0) {
        // Synchronous delay (better-sqlite3 is sync)
        const start = Date.now();
        while (Date.now() - start < CodeGraphDB.RETRY_DELAY_MS) {
          // Busy wait
        }
        return this.runWithRetry(fn, retries - 1);
      }
      throw new DatabaseError(
        `Database operation failed: ${(error as Error).message}`,
        error as Error
      );
    }
  }

  // ==========================================================================
  // Save Operations
  // ==========================================================================

  /**
   * Save a complete CodeGraph to the database.
   * Uses a transaction for atomicity and performance.
   * 
   * @param nodes - Map of file paths to CodeNode
   * @param entryPoints - Array of entry point definitions
   * @param indexedVia - How files were indexed ('scan' for full scan, 'watch' for incremental)
   */
  saveGraph(
    nodes: Map<string, CodeNode>, 
    entryPoints: Array<{ file: string; framework?: string; role: string; type: string }>,
    indexedVia: 'scan' | 'watch' = 'scan'
  ): void {
    this.runWithRetry(() => {
      const transaction = this.db.transaction(() => {
        const now = Date.now();

        // ✅ Only clear data that matches the indexing method
        if (indexedVia === 'scan') {
          this.clearProject();
        }

        // ✅ Prepare statements once
        const insertFile = this.db.prepare(`
          INSERT OR REPLACE INTO files (
            project_path, file_path, relative_path, content_hash, tree_hash,
            size, lines, depth, last_indexed, functions_count, classes_count,
            types_count, imports_count, exported_count, parsed_ast, ast, indexed_via
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertDep = this.db.prepare(`
          INSERT OR REPLACE INTO dependencies (project_path, source_file, target_file, import_type, created_at)
          VALUES (?, ?, ?, ?, ?)
        `);

        const insertEntry = this.db.prepare(`
          INSERT OR REPLACE INTO entry_points (project_path, file_path, framework, role, type, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `);

        // ✅ Single-pass stats calculation
        let totalSize = 0;
        let totalLines = 0;
        let totalFunctions = 0;
        let totalClasses = 0;
        let totalTypes = 0;

        // Insert files with full AST data
        for (const [filePath, node] of nodes.entries()) {
          // ✅ Calculate stats in same loop
          totalSize += node.size;
          totalLines += node.lines;
          totalFunctions += node.parsed.functions.length;
          totalClasses += node.parsed.classes.length;
          totalTypes += node.parsed.types.length;

          // ✅ Serialize full AST data
          const parsedAst = JSON.stringify(node.parsed);
          const ast = node.ast ? JSON.stringify(node.ast) : null;

          insertFile.run(
            this.projectPath,
            filePath,
            node.relativePath,
            node.hash,
            node.treeHash,
            node.size,
            node.lines,
            node.depth,
            now,
            node.parsed.functions.length,
            node.parsed.classes.length,
            node.parsed.types.length,
            node.imports.length,
            node.parsed.exports.length,
            parsedAst,
            ast,
            indexedVia
          );

          // Insert dependencies with type classification
          for (const targetFile of node.imports) {
            // Determine import type from parsed data
            const importInfo = node.parsed.imports.find(imp => {
              // Match by source path (approximate - would need resolution)
              return targetFile.includes(imp.source.replace(/^\.\//, ''));
            });
            const importType = importInfo?.isTypeOnly ? 'type-only' : 'static';
            
            insertDep.run(this.projectPath, filePath, targetFile, importType, now);
          }
        }

        // Insert entry points
        for (const entryPoint of entryPoints) {
          insertEntry.run(
            this.projectPath,
            entryPoint.file,
            entryPoint.framework || null,
            entryPoint.role,
            entryPoint.type,
            now
          );
        }

        // Save stats with schema version
        this.db.prepare(`
          INSERT OR REPLACE INTO stats (
            project_path, total_files, total_size, total_lines,
            total_functions, total_classes, total_types, last_scan, schema_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          this.projectPath,
          nodes.size,
          totalSize,
          totalLines,
          totalFunctions,
          totalClasses,
          totalTypes,
          now,
          CodeGraphDB.SCHEMA_VERSION
        );
      });

      transaction();
    });
  }

  /**
   * Upsert a single file (for incremental updates).
   */
  upsertFile(node: CodeNode, indexedVia: 'scan' | 'watch' = 'watch'): void {
    this.runWithRetry(() => {
      const transaction = this.db.transaction(() => {
        const now = Date.now();

        // Delete old dependencies for this file
        this.db.prepare(`
          DELETE FROM dependencies WHERE project_path = ? AND source_file = ?
        `).run(this.projectPath, node.filePath);

        // Upsert file with both parsed structure and complete AST
        const parsedAst = JSON.stringify(node.parsed);
        const ast = node.ast ? JSON.stringify(node.ast) : null;
        
        this.db.prepare(`
          INSERT OR REPLACE INTO files (
            project_path, file_path, relative_path, content_hash, tree_hash,
            size, lines, depth, last_indexed, functions_count, classes_count,
            types_count, imports_count, exported_count, parsed_ast, ast, indexed_via
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          this.projectPath,
          node.filePath,
          node.relativePath,
          node.hash,
          node.treeHash,
          node.size,
          node.lines,
          node.depth,
          now,
          node.parsed.functions.length,
          node.parsed.classes.length,
          node.parsed.types.length,
          node.imports.length,
          node.parsed.exports.length,
          parsedAst,
          ast,
          indexedVia
        );

        // Insert new dependencies
        const insertDep = this.db.prepare(`
          INSERT OR REPLACE INTO dependencies (project_path, source_file, target_file, import_type, created_at)
          VALUES (?, ?, ?, ?, ?)
        `);

        for (const targetFile of node.imports) {
          insertDep.run(this.projectPath, node.filePath, targetFile, 'static', now);
        }

        // Recalculate stats
        this.recalculateStats();
      });

      transaction();
    });
  }

  /**
   * Remove a file from the database.
   */
  removeFile(filePath: string): void {
    this.runWithRetry(() => {
      const transaction = this.db.transaction(() => {
        this.db.prepare(`DELETE FROM files WHERE project_path = ? AND file_path = ?`).run(this.projectPath, filePath);
        this.db.prepare(`DELETE FROM dependencies WHERE project_path = ? AND (source_file = ? OR target_file = ?)`).run(this.projectPath, filePath, filePath);
        this.recalculateStats();
      });

      transaction();
    });
  }

  /**
   * Recalculate project stats from current files.
   */
  private recalculateStats(): void {
    const stats = this.db.prepare(`
      SELECT 
        COUNT(*) as total_files,
        SUM(size) as total_size,
        SUM(lines) as total_lines,
        SUM(functions_count) as total_functions,
        SUM(classes_count) as total_classes,
        SUM(types_count) as total_types
      FROM files WHERE project_path = ?
    `).get(this.projectPath) as {
      total_files: number;
      total_size: number;
      total_lines: number;
      total_functions: number;
      total_classes: number;
      total_types: number;
    };

    this.db.prepare(`
      INSERT OR REPLACE INTO stats (
        project_path, total_files, total_size, total_lines,
        total_functions, total_classes, total_types, last_scan, schema_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.projectPath,
      stats.total_files || 0,
      stats.total_size || 0,
      stats.total_lines || 0,
      stats.total_functions || 0,
      stats.total_classes || 0,
      stats.total_types || 0,
      Date.now(),
      CodeGraphDB.SCHEMA_VERSION
    );
  }

  // ==========================================================================
  // Load Operations
  // ==========================================================================

  /**
   * Load the complete graph from the database.
   * ✅ Now includes full AST data!
   */
  loadGraph(): { nodes: Map<string, CodeNode>; entryPoints: DBEntryPoint[] } | null {
    const stats = this.getStats();
    if (!stats) return null;

    const nodes = new Map<string, CodeNode>();

    // Load files with parsed AST
    const files = this.db.prepare(`
      SELECT * FROM files WHERE project_path = ?
    `).all(this.projectPath) as DBFileNode[];

    for (const file of files) {
      // ✅ Parse stored AST JSON
      let parsed: ParsedFile;
      try {
        parsed = JSON.parse(file.parsed_ast || '{}') as ParsedFile;
        // Ensure all arrays exist
        parsed.functions = parsed.functions || [];
        parsed.classes = parsed.classes || [];
        parsed.imports = parsed.imports || [];
        parsed.exports = parsed.exports || [];
        parsed.types = parsed.types || [];
      } catch {
        parsed = { functions: [], classes: [], imports: [], exports: [], types: [] };
      }

      nodes.set(file.file_path, {
        filePath: file.file_path,
        relativePath: file.relative_path,
        hash: file.content_hash,
        treeHash: file.tree_hash,
        size: file.size,
        lines: file.lines,
        depth: file.depth,
        imports: [],
        importedBy: [],
        lastModified: file.last_indexed,
        parsed,
        meta: {
          extension: path.extname(file.file_path),
          isTest: /\.(test|spec)\.[jt]sx?$/.test(file.file_path),
          isEntry: false,
          hasExports: parsed.exports.length > 0,
          hasDefaultExport: parsed.exports.includes('default'),
          complexity: parsed.functions.length + parsed.classes.length
        }
      });
    }

    // Load dependencies
    const deps = this.db.prepare(`
      SELECT * FROM dependencies WHERE project_path = ?
    `).all(this.projectPath) as DBDependency[];

    for (const dep of deps) {
      const sourceNode = nodes.get(dep.source_file);
      const targetNode = nodes.get(dep.target_file);
      
      if (sourceNode) {
        sourceNode.imports.push(dep.target_file);
      }
      if (targetNode) {
        targetNode.importedBy.push(dep.source_file);
      }
    }

    // Load entry points and mark files
    const entryPoints = this.db.prepare(`
      SELECT * FROM entry_points WHERE project_path = ?
    `).all(this.projectPath) as DBEntryPoint[];

    for (const ep of entryPoints) {
      const node = nodes.get(ep.file_path);
      if (node) {
        node.meta.isEntry = true;
      }
    }

    return { nodes, entryPoints };
  }

  /**
   * Get statistics for this project.
   */
  getStats(): DBStats | null {
    const stats = this.db.prepare(`
      SELECT * FROM stats WHERE project_path = ?
    `).get(this.projectPath);

    return stats as DBStats | null;
  }

  /**
   * Get all files in this project.
   */
  getFiles(): DBFileNode[] {
    return this.db.prepare(`
      SELECT * FROM files WHERE project_path = ?
      ORDER BY relative_path
    `).all(this.projectPath) as DBFileNode[];
  }

  /**
   * ✅ Stream files for large datasets (memory efficient)
   */
  *streamFiles(): Generator<DBFileNode> {
    const stmt = this.db.prepare(`
      SELECT * FROM files WHERE project_path = ?
      ORDER BY relative_path
    `);
    
    for (const row of stmt.iterate(this.projectPath)) {
      yield row as DBFileNode;
    }
  }

  /**
   * Get a single file by path.
   */
  getFile(filePath: string): DBFileNode | null {
    const file = this.db.prepare(`
      SELECT * FROM files WHERE project_path = ? AND file_path = ?
    `).get(this.projectPath, filePath);

    return file as DBFileNode | null;
  }

  /**
   * Get a file by its relative path.
   */
  getFileByRelativePath(relativePath: string): DBFileNode | null {
    const file = this.db.prepare(`
      SELECT * FROM files WHERE project_path = ? AND relative_path = ?
    `).get(this.projectPath, relativePath);

    return file as DBFileNode | null;
  }

  /**
   * Get dependencies for a specific file.
   */
  getDependencies(filePath: string): DBDependency[] {
    return this.db.prepare(`
      SELECT * FROM dependencies
      WHERE project_path = ? AND source_file = ?
    `).all(this.projectPath, filePath) as DBDependency[];
  }

  /**
   * Get dependents (files that import this file).
   */
  getDependents(filePath: string): DBDependency[] {
    return this.db.prepare(`
      SELECT * FROM dependencies
      WHERE project_path = ? AND target_file = ?
    `).all(this.projectPath, filePath) as DBDependency[];
  }

  /**
   * Get entry points for this project.
   */
  getEntryPoints(): DBEntryPoint[] {
    return this.db.prepare(`
      SELECT * FROM entry_points WHERE project_path = ?
    `).all(this.projectPath) as DBEntryPoint[];
  }

  /**
   * Check if a file exists in the database.
   */
  hasFile(filePath: string): boolean {
    const result = this.db.prepare(`
      SELECT 1 FROM files WHERE project_path = ? AND file_path = ?
    `).get(this.projectPath, filePath);
    
    return result !== undefined;
  }

  /**
   * Check if a file's hash has changed.
   */
  hasFileChanged(filePath: string, newHash: string): boolean {
    const file = this.getFile(filePath);
    return !file || file.content_hash !== newHash;
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Clear all data for this project.
   */
  clearProject(): void {
    this.runWithRetry(() => {
      const transaction = this.db.transaction(() => {
        this.db.prepare('DELETE FROM files WHERE project_path = ?').run(this.projectPath);
        this.db.prepare('DELETE FROM dependencies WHERE project_path = ?').run(this.projectPath);
        this.db.prepare('DELETE FROM entry_points WHERE project_path = ?').run(this.projectPath);
        this.db.prepare('DELETE FROM stats WHERE project_path = ?').run(this.projectPath);
      });

      transaction();
    });
  }

  /**
   * Get list of all tables in the database.
   */
  getTables(): Array<{ name: string; row_count: number }> {
    const tables = this.db.prepare(`
      SELECT name 
      FROM sqlite_master 
      WHERE type='table' 
      AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;

    return tables.map(table => ({
      name: table.name,
      row_count: this.getTableCount(table.name)
    }));
  }

  /**
   * Get row count for a specific table.
   */
  getTableCount(tableName: string): number {
    try {
      const result = this.db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get() as { count: number };
      return result.count;
    } catch {
      return 0;
    }
  }

  /**
   * Query a table with pagination.
   */
  queryTable(tableName: string, limit: number, offset: number): unknown[] {
    try {
      return this.db.prepare(`
        SELECT * FROM ${tableName}
        LIMIT ? OFFSET ?
      `).all(limit, offset);
    } catch (error) {
      console.error(`Error querying table ${tableName}:`, error);
      return [];
    }
  }

  /**
   * Execute a custom SQL query (SELECT only for safety).
   */
  executeQuery(query: string, params: unknown[] = []): unknown[] {
    // Only allow SELECT queries for safety
    const trimmedQuery = query.trim().toUpperCase();
    if (!trimmedQuery.startsWith('SELECT')) {
      throw new Error('Only SELECT queries are allowed');
    }

    try {
      return this.db.prepare(query).all(...params);
    } catch (error) {
      throw new Error(`Query execution failed: ${(error as Error).message}`);
    }
  }

  // ==========================================================================
  // Embeddings Operations
  // ==========================================================================

  /**
   * Save embeddings for a file's code chunks.
   * 
   * @param fileId - The database ID of the file
   * @param chunks - Array of chunks with their embeddings
   */
  saveEmbeddings(
    fileId: number,
    chunks: Array<{
      type: 'function' | 'class' | 'file' | 'type';
      name: string;
      text: string;
      embedding: number[];
    }>
  ): void {
    this.runWithRetry(() => {
      const transaction = this.db.transaction(() => {
        // Get embedding IDs BEFORE deleting from main table
        const oldEmbeddingIds = (this.db.prepare(`
          SELECT id FROM embeddings WHERE file_id = ?
        `).all(fileId) as Array<{ id: number }>).map((row) => row.id);

        // Delete from vector table first
        for (const id of oldEmbeddingIds) {
          this.db.prepare(`
            DELETE FROM vec_embeddings WHERE rowid = ?
          `).run(id);
        }

        // Then delete from main embeddings table
        this.db.prepare(`
          DELETE FROM embeddings WHERE file_id = ?
        `).run(fileId);

        const insertStmt = this.db.prepare(`
          INSERT INTO embeddings (file_id, chunk_type, chunk_name, chunk_text, embedding, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `);

        const insertVecStmt = this.db.prepare(`
          INSERT INTO vec_embeddings (rowid, embedding)
          VALUES (?, ?)
        `);

        for (const chunk of chunks) {
          // Convert embedding array to Float32Array buffer
          const embeddingBuffer = Buffer.from(new Float32Array(chunk.embedding).buffer);

          // Insert into main table first
          const result = insertStmt.run(
            fileId,
            chunk.type,
            chunk.name,
            chunk.text,
            embeddingBuffer,
            Date.now()
          );

          // Insert into vector search table
          // Keep rowid aligned with embeddings.id for reliable joins
          insertVecStmt.run(result.lastInsertRowid, embeddingBuffer);
        }
      });

      transaction();
    });
  }

  /**
   * Search for similar code using vector similarity.
   * 
   * @param queryEmbedding - The embedding vector to search for
   * @param limit - Maximum number of results (default: 10)
   * @param chunkTypes - Filter by chunk types (optional)
   * @returns Array of matching chunks with similarity scores
   */
  searchSimilar(
    queryEmbedding: number[],
    limit = 10,
    chunkTypes?: Array<'function' | 'class' | 'file' | 'type'>
  ): Array<{
    fileId: number;
    filePath: string;
    chunkType: string;
    chunkName: string;
    chunkText: string;
    similarity: number;
  }> {
    const embeddingBuffer = Buffer.from(new Float32Array(queryEmbedding).buffer);

    // Build query with optional type filter
    let query = `
      SELECT 
        e.file_id,
        f.relative_path,
        e.chunk_type,
        e.chunk_name,
        e.chunk_text,
        vec_distance_cosine(v.embedding, ?) as distance
      FROM embeddings e
      JOIN files f ON e.file_id = f.id
      JOIN vec_embeddings v ON v.rowid = e.id
      WHERE f.project_path = ?
    `;

    const params: (Buffer | string | number)[] = [embeddingBuffer, this.projectPath];

    if (chunkTypes && chunkTypes.length > 0) {
      const placeholders = chunkTypes.map(() => '?').join(',');
      query += ` AND e.chunk_type IN (${placeholders})`;
      params.push(...chunkTypes);
    }

    query += ` ORDER BY distance ASC LIMIT ?`;
    params.push(limit);

    const results = this.db.prepare(query).all(...params) as Array<{
      file_id: number;
      relative_path: string;
      chunk_type: string;
      chunk_name: string;
      chunk_text: string;
      distance: number;
    }>;

    return results.map((row) => ({
      fileId: row.file_id,
      filePath: row.relative_path,
      chunkType: row.chunk_type,
      chunkName: row.chunk_name,
      chunkText: row.chunk_text,
      similarity: 1 - row.distance, // Convert distance to similarity (0-1)
    }));
  }

  /**
   * Get all embeddings for a specific file.
   * 
   * @param fileId - The database ID of the file
   * @returns Array of embeddings with metadata
   */
  getFileEmbeddings(fileId: number): Array<{
    id: number;
    chunkType: string;
    chunkName: string;
    chunkText: string;
    createdAt: number;
  }> {
    const results = this.db.prepare(`
      SELECT id, chunk_type, chunk_name, chunk_text, created_at
      FROM embeddings
      WHERE file_id = ?
      ORDER BY chunk_type, chunk_name
    `).all(fileId) as Array<{
      id: number;
      chunk_type: string;
      chunk_name: string;
      chunk_text: string;
      created_at: number;
    }>;
    
    return results.map((row) => ({
      id: row.id,
      chunkType: row.chunk_type,
      chunkName: row.chunk_name,
      chunkText: row.chunk_text,
      createdAt: row.created_at,
    }));
  }

  /**
   * Delete all embeddings for a specific file.
   * 
   * @param fileId - The database ID of the file
   */
  deleteFileEmbeddings(fileId: number): void {
    this.runWithRetry(() => {
      const transaction = this.db.transaction(() => {
        // Get embedding IDs first
        const embeddingIds = (this.db.prepare(`
          SELECT id FROM embeddings WHERE file_id = ?
        `).all(fileId) as Array<{ id: number }>).map((row) => row.id);

        // Delete from vector table
        for (const id of embeddingIds) {
          this.db.prepare(`
            DELETE FROM vec_embeddings WHERE rowid = ?
          `).run(id);
        }

        // Delete from main table
        this.db.prepare(`
          DELETE FROM embeddings WHERE file_id = ?
        `).run(fileId);
      });

      transaction();
    });
  }

  /**
   * Get count of embeddings in the database.
   */
  getEmbeddingsCount(): number {
    const result = this.db.prepare(`
      SELECT COUNT(*) as count FROM embeddings
    `).get() as { count: number };
    return result.count;
  }

  /**
   * Check if a file has embeddings.
   * 
   * @param fileId - The database ID of the file
   * @returns True if embeddings exist
   */
  hasEmbeddings(fileId: number): boolean {
    const result = this.db.prepare(`
      SELECT 1 FROM embeddings WHERE file_id = ? LIMIT 1
    `).get(fileId);
    return result !== undefined;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    try {
      // Checkpoint WAL before closing
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      this.db.close();
    } catch (error) {
      console.warn('DB close warning:', (error as Error).message);
    }
  }

  /**
   * Get database info for debugging.
   */
  getInfo(): { path: string; version: number; projectPath: string } {
    return {
      path: this.dbPath,
      version: this.getUserVersion(),
      projectPath: this.projectPath
    };
  }

  /**
   * Vacuum the database to reclaim space.
   */
  vacuum(): void {
    this.db.exec('VACUUM');
  }

  /**
   * Generate a content hash for a file.
   */
  static hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }
}
