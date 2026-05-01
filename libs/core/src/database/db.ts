import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { load as loadSqliteVec } from 'sqlite-vec';
import type { CodeNode, ParsedFile, ParsedSymbol, GraphEdge, EdgeKind, EdgeProvenance, SymbolKind } from '../types';
import type { DBEntryPoint, DBFileNode, DBDependency, DBStats } from '../types';
import { buildEdgesForNode } from '../analysis/symbol-extractor';

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
 * SCHEMA VERSION: 6
 */
export class CodeGraphDB {
  private db: Database.Database;
  private projectPath: string;
  private readonly dbPath: string;
  
  private static readonly SCHEMA_VERSION = 6;
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

      // ✅ Ensure schema is present (single version)
      this.ensureSchema();
      
      // ✅ Ensure .gitignore includes .raiken/
      this.ensureGitignore();
      
    } catch (error) {
      if (error instanceof DatabaseError) {
        throw error;
      }
      const msg = (error as Error).message || '';
      if (msg.includes('malformed') || msg.includes('corrupt') || msg.includes('not a database')) {
        const backupPath = `${this.dbPath}.corrupt.${Date.now()}`;
        try {
          const fsSync = require('node:fs');
          if (fsSync.existsSync(this.dbPath)) {
            fsSync.renameSync(this.dbPath, backupPath);
          }
        } catch { /* best-effort backup */ }
        throw new DatabaseError(
          `Database is corrupted. The broken file has been backed up to ${backupPath}. Restart Raiken to create a fresh database. Your code graph will be rebuilt automatically.`,
          error as Error
        );
      }
      throw new DatabaseError(
        `Failed to initialize CodeGraphDB at ${this.dbPath}: ${msg}`,
        error as Error
      );
    }
  }

  // ==========================================================================
  // Schema Management
  // ==========================================================================

  private getUserVersion(): number {
    const result = this.db.pragma('user_version', { simple: true }) as number;
    return result;
  }

  private setUserVersion(version: number): void {
    this.db.pragma(`user_version = ${version}`);
  }

  /**
   * Ensure schema exists and run migrations if needed.
   */
  private ensureSchema(): void {
    const currentVersion = this.getUserVersion();

    // Fresh database - create v1 schema and migrate to latest
    if (currentVersion === 0) {
      this.createV1Schema();
      this.setUserVersion(1);
    }

    // Run migrations
    this.runMigrations();

    // Idempotent schema extensions (safe to run on every startup)
    this.ensureEmbeddingsSchema();
    this.ensureKeywordIndexSchema();
    this.ensureMemorySchema();
    this.ensureDependencyColumns();
    this.ensureFileColumns();
    this.ensureSymbolGraphSchema();
  }

  /**
   * Symbol-level + edge graph schema.
   *
   * `symbols` holds first-class units (functions, classes, methods, routes, ...).
   * `graph_edges` is a unified edge table: every relationship between files or
   * symbols carries provenance + a 0..1 confidence so callers can weight
   * evidence (static AST vs. runtime vs. inferred).
   */
  private ensureSymbolGraphSchema(): void {
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS symbols (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL,
          file_path TEXT NOT NULL,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          is_exported INTEGER DEFAULT 0,
          is_async INTEGER DEFAULT 0,
          parent TEXT,
          signature TEXT,
          callees TEXT,
          rendered TEXT,
          route_meta TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_symbols_project ON symbols(project_path);
        CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
        CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
        CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_symbols_unique
          ON symbols(project_path, file_path, name, kind, start_line);
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS graph_edges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL,
          kind TEXT NOT NULL,
          source_file TEXT NOT NULL,
          target_file TEXT NOT NULL,
          source_symbol TEXT,
          target_symbol TEXT,
          provenance TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 1.0,
          evidence TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_edges_project ON graph_edges(project_path);
        CREATE INDEX IF NOT EXISTS idx_edges_source ON graph_edges(source_file);
        CREATE INDEX IF NOT EXISTS idx_edges_target ON graph_edges(target_file);
        CREATE INDEX IF NOT EXISTS idx_edges_kind ON graph_edges(kind);
        CREATE INDEX IF NOT EXISTS idx_edges_provenance ON graph_edges(provenance);
      `);
    })();
  }

  /**
   * Run migrations from current version to latest.
   */
  private runMigrations(): void {
    const currentVersion = this.getUserVersion();

    if (currentVersion < 2) {
      this.migrateToV2();
      this.setUserVersion(2);
    }

    if (currentVersion < 3) {
      this.migrateToV3();
      this.setUserVersion(3);
    }

    if (currentVersion < 4) {
      this.migrateToV4();
      this.setUserVersion(4);
    }

    if (currentVersion < 5) {
      this.migrateToV5();
      this.setUserVersion(5);
    }

    if (currentVersion < 6) {
      this.migrateToV6();
      this.setUserVersion(6);
    }
  }

  /**
   * Migration to v2 (placeholder for future features).
   */
  private migrateToV2(): void {
    // No schema changes in v2
    // This version is reserved for future use
  }

  /**
   * Migration to v3 (placeholder for future features).
   */
  private migrateToV3(): void {
    // No schema changes in v3
    // This version is reserved for future use
  }

  /**
   * Migration to v4 - Autonomous DOM Traversal.
   * Adds tables for site discovery: discovered_pages, discovered_links, auth_blockers, discovery_sessions.
   */
  private migrateToV4(): void {
    this.db.transaction(() => {
      // Discovered pages table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS discovered_pages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL,
          url TEXT NOT NULL,
          normalized_url TEXT NOT NULL,
          title TEXT,
          snapshot_json TEXT,
          parent_url TEXT,
          navigation_action TEXT,
          depth INTEGER DEFAULT 0,
          discovered_at INTEGER NOT NULL,
          last_visited_at INTEGER NOT NULL,
          visit_count INTEGER DEFAULT 1,
          UNIQUE(project_path, normalized_url)
        );

        CREATE INDEX IF NOT EXISTS idx_pages_project ON discovered_pages(project_path);
        CREATE INDEX IF NOT EXISTS idx_pages_normalized ON discovered_pages(normalized_url);
      `);

      // Discovered links table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS discovered_links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL,
          from_url TEXT NOT NULL,
          to_url TEXT NOT NULL,
          selector TEXT NOT NULL,
          link_text TEXT,
          element_role TEXT,
          status TEXT DEFAULT 'pending',
          error_message TEXT,
          discovered_at INTEGER NOT NULL,
          verified_at INTEGER,
          UNIQUE(project_path, from_url, to_url, selector)
        );

        CREATE INDEX IF NOT EXISTS idx_links_from ON discovered_links(from_url);
        CREATE INDEX IF NOT EXISTS idx_links_status ON discovered_links(status);
      `);

      // Auth blockers table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS auth_blockers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL,
          url TEXT NOT NULL,
          blocker_type TEXT NOT NULL,
          detected_elements TEXT,
          resolved_at INTEGER,
          storage_state_path TEXT,
          discovered_at INTEGER NOT NULL
        );
      `);

      // Discovery sessions table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS discovery_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL,
          start_url TEXT NOT NULL,
          status TEXT DEFAULT 'running',
          pages_discovered INTEGER DEFAULT 0,
          links_found INTEGER DEFAULT 0,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          blocked_at_url TEXT,
          queue_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_status ON discovery_sessions(status);
        CREATE INDEX IF NOT EXISTS idx_sessions_project ON discovery_sessions(project_path);
      `);
    })();
  }

  /**
   * Migration to v5 - Discovery session metadata.
   * Adds max_pages and max_depth columns to discovery_sessions.
   */
  private migrateToV5(): void {
    const tableInfo = this.db
      .prepare(`PRAGMA table_info(discovery_sessions)`)
      .all() as Array<{ name: string }>;
    const columnNames = tableInfo.map(col => col.name);

    this.db.transaction(() => {
      if (!columnNames.includes('max_pages')) {
        this.db.exec(`ALTER TABLE discovery_sessions ADD COLUMN max_pages INTEGER`);
      }
      if (!columnNames.includes('max_depth')) {
        this.db.exec(`ALTER TABLE discovery_sessions ADD COLUMN max_depth INTEGER`);
      }
    })();
  }

  /**
   * Migration to v6 - Generic discovery blockers.
   *
   * Replaces the `auth_blockers` table with `discovery_blockers`, broadening
   * the abstraction so the crawler can record any reason it had to stop on a
   * page (auth wall, captcha, consent banner, rate-limit page, etc.) and the
   * dashboard can offer category-appropriate resolution actions.
   *
   * Migration is forward-only and copy-then-drop, so a v5 -> v6 upgrade
   * preserves every existing `auth_blockers` row as a `discovery_blockers`
   * row with `category='auth_required'`.
   *
   * Also extends `discovery_sessions` with two session-scoped columns that
   * survive a pause/resume cycle: `skipped_urls_json` (URLs the user told us
   * to skip after a blocker) and `ignored_categories_json` (blocker
   * categories the user told us to log-only for the rest of this session).
   */
  private migrateToV6(): void {
    this.db.transaction(() => {
      const tables = this.db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all() as Array<{ name: string }>;
      const tableNames = new Set(tables.map(t => t.name));

      // 1. Create the new generalised table.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS discovery_blockers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL,
          url TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'auth_required',
          severity TEXT NOT NULL DEFAULT 'pause',
          detector_id TEXT,
          detected_elements TEXT,
          evidence_json TEXT,
          screenshot_path TEXT,
          resolution TEXT,
          resolved_via TEXT,
          resolved_at INTEGER,
          storage_state_path TEXT,
          discovered_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_blockers_project ON discovery_blockers(project_path);
        CREATE INDEX IF NOT EXISTS idx_blockers_unresolved
          ON discovery_blockers(project_path, resolved_at);
      `);

      // 2. Copy existing rows from auth_blockers, preserving original ids so
      //    in-flight references (e.g. the legacy `getAuthBlockers` query in
      //    the dashboard) keep pointing at the same blocker.
      if (tableNames.has('auth_blockers')) {
        this.db.exec(`
          INSERT INTO discovery_blockers (
            id, project_path, url, category, severity,
            detector_id, detected_elements, evidence_json,
            screenshot_path, resolution, resolved_via,
            resolved_at, storage_state_path, discovered_at
          )
          SELECT
            id, project_path, url, 'auth_required', 'pause',
            'auth:' || COALESCE(blocker_type, 'unknown'),
            detected_elements, NULL,
            NULL,
            CASE WHEN resolved_at IS NULL THEN NULL ELSE 'provide_state' END,
            CASE WHEN resolved_at IS NULL THEN NULL ELSE 'auth_command' END,
            resolved_at, storage_state_path, discovered_at
          FROM auth_blockers;
        `);

        // 3. Drop the legacy table. SiteKnowledgeDB exposes back-compat
        //    method names so callers don't break.
        this.db.exec(`DROP TABLE auth_blockers;`);
      }

      // 4. Session-scoped resolution memory.
      const sessionInfo = this.db
        .prepare(`PRAGMA table_info(discovery_sessions)`)
        .all() as Array<{ name: string }>;
      const sessionColumns = new Set(sessionInfo.map(c => c.name));
      if (!sessionColumns.has('skipped_urls_json')) {
        this.db.exec(`ALTER TABLE discovery_sessions ADD COLUMN skipped_urls_json TEXT`);
      }
      if (!sessionColumns.has('ignored_categories_json')) {
        this.db.exec(
          `ALTER TABLE discovery_sessions ADD COLUMN ignored_categories_json TEXT`,
        );
      }
    })();
  }

  getRawDatabase(): Database.Database {
    return this.db;
  }

  private ensureFileColumns(): void {
    const tableInfo = this.db.prepare(`PRAGMA table_info(files)`).all() as Array<{ name: string }>;
    const columnNames = tableInfo.map(col => col.name);

    this.db.transaction(() => {
      if (!columnNames.includes('parsed_ast')) {
        this.db.exec(`ALTER TABLE files ADD COLUMN parsed_ast TEXT DEFAULT '{}'`);
      }
      if (!columnNames.includes('ast')) {
        this.db.exec(`ALTER TABLE files ADD COLUMN ast TEXT DEFAULT NULL`);
      }
      if (!columnNames.includes('indexed_via')) {
        this.db.exec(`ALTER TABLE files ADD COLUMN indexed_via TEXT DEFAULT 'scan'`);
      }
      if (!columnNames.includes('last_modified')) {
        this.db.exec(`ALTER TABLE files ADD COLUMN last_modified INTEGER DEFAULT 0`);
      }
    })();
  }

  private ensureDependencyColumns(): void {
    const depsInfo = this.db.prepare(`PRAGMA table_info(dependencies)`).all() as Array<{ name: string }>;
    if (!depsInfo.some(col => col.name === 'import_type')) {
      this.db.exec(`ALTER TABLE dependencies ADD COLUMN import_type TEXT DEFAULT 'static'`);
    }
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

  private ensureEmbeddingsSchema(): void {
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
    })();
  }

  private ensureKeywordIndexSchema(): void {
    this.db.transaction(() => {
      // Create keyword index table for fast semantic search
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS keyword_index (
          keyword TEXT NOT NULL,
          file_path TEXT NOT NULL,
          project_path TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (project_path, keyword, file_path)
        );

        CREATE INDEX IF NOT EXISTS idx_keyword_project ON keyword_index(project_path);
        CREATE INDEX IF NOT EXISTS idx_keyword_keyword ON keyword_index(keyword);
        CREATE INDEX IF NOT EXISTS idx_keyword_updated ON keyword_index(updated_at);
      `);
    })();
  }

  private ensureMemorySchema(): void {
    this.db.transaction(() => {
      // User preferences (project-level settings)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS preferences (
          project_path TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (project_path, key)
        );

        CREATE INDEX IF NOT EXISTS idx_preferences_project ON preferences(project_path);
      `);

      // Selector history (track what worked/failed)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS selector_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL,
          element_description TEXT NOT NULL,
          selector TEXT NOT NULL,
          selector_type TEXT NOT NULL CHECK(selector_type IN ('data-testid', 'role', 'text', 'css', 'xpath', 'other')),
          success_count INTEGER DEFAULT 0,
          failure_count INTEGER DEFAULT 0,
          last_used INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_selector_project ON selector_history(project_path);
        CREATE INDEX IF NOT EXISTS idx_selector_element ON selector_history(element_description);
        CREATE INDEX IF NOT EXISTS idx_selector_last_used ON selector_history(last_used);
      `);

      // Test outcomes (generated tests and their results)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS test_outcomes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL,
          test_file TEXT NOT NULL,
          test_name TEXT NOT NULL,
          source_prompt TEXT NOT NULL,
          generated_code TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending', 'passed', 'failed', 'error', 'timeout')),
          error_message TEXT,
          failing_selector TEXT,
          execution_time_ms INTEGER,
          retry_count INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL,
          last_run INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_outcomes_project ON test_outcomes(project_path);
        CREATE INDEX IF NOT EXISTS idx_outcomes_status ON test_outcomes(status);
        CREATE INDEX IF NOT EXISTS idx_outcomes_file ON test_outcomes(test_file);
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS test_source_map (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL,
          test_file TEXT NOT NULL,
          source_file TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(project_path, test_file, source_file)
        );

        CREATE INDEX IF NOT EXISTS idx_tsm_project ON test_source_map(project_path);
        CREATE INDEX IF NOT EXISTS idx_tsm_source ON test_source_map(source_file);
        CREATE INDEX IF NOT EXISTS idx_tsm_test ON test_source_map(test_file);
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
        const start = Date.now();
        while (Date.now() - start < CodeGraphDB.RETRY_DELAY_MS) {
            // spin-wait; better-sqlite3 is synchronous so we can't await
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

          // Persist symbol-level data and unified edges for this file.
          if (node.symbols && node.symbols.length > 0) {
            this.replaceFileSymbolsInTransaction(filePath, node.symbols, now);
          }
          const edges = buildEdgesForNode(node, node.intraFileEdges ?? []);
          if (edges.length > 0) {
            this.replaceFileEdgesInTransaction(filePath, edges, now);
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

        // Persist symbol-level data and unified edges for this file.
        if (node.symbols && node.symbols.length > 0) {
          this.replaceFileSymbolsInTransaction(node.filePath, node.symbols, now);
        } else {
          // Even if there are no symbols (e.g. binary or parse failure), make
          // sure we don't leave stale rows behind.
          this.db.prepare(`
            DELETE FROM symbols WHERE project_path = ? AND file_path = ?
          `).run(this.projectPath, node.filePath);
        }

        const edges = buildEdgesForNode(node, node.intraFileEdges ?? []);
        this.replaceFileEdgesInTransaction(node.filePath, edges, now);

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
        // Clean vec_embeddings before deleting the file (no FK cascade on virtual table)
        const embeddingIds = (this.db.prepare(`
          SELECT e.id FROM embeddings e
          JOIN files f ON e.file_id = f.id
          WHERE f.project_path = ? AND f.file_path = ?
        `).all(this.projectPath, filePath) as Array<{ id: number }>).map(r => r.id);

        if (embeddingIds.length > 0) {
          const deleteVec = this.db.prepare(`DELETE FROM vec_embeddings WHERE rowid = ?`);
          for (const id of embeddingIds) {
            deleteVec.run(id);
          }
        }

        this.db.prepare(`DELETE FROM files WHERE project_path = ? AND file_path = ?`).run(this.projectPath, filePath);
        this.db.prepare(`DELETE FROM dependencies WHERE project_path = ? AND (source_file = ? OR target_file = ?)`).run(this.projectPath, filePath, filePath);
        this.db.prepare(`DELETE FROM symbols WHERE project_path = ? AND file_path = ?`).run(this.projectPath, filePath);
        this.db.prepare(`DELETE FROM graph_edges WHERE project_path = ? AND (source_file = ? OR target_file = ?)`).run(this.projectPath, filePath, filePath);
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

      let ast: unknown | undefined;
      try {
        ast = file.ast ? JSON.parse(file.ast) : undefined;
      } catch {
        ast = undefined;
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
        ast,
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
        // Clean vec_embeddings before deleting files (no FK cascade on virtual table)
        const embeddingIds = (this.db.prepare(`
          SELECT e.id FROM embeddings e
          JOIN files f ON e.file_id = f.id
          WHERE f.project_path = ?
        `).all(this.projectPath) as Array<{ id: number }>).map(r => r.id);

        if (embeddingIds.length > 0) {
          const deleteVec = this.db.prepare(`DELETE FROM vec_embeddings WHERE rowid = ?`);
          for (const id of embeddingIds) {
            deleteVec.run(id);
          }
        }

        this.db.prepare('DELETE FROM files WHERE project_path = ?').run(this.projectPath);
        this.db.prepare('DELETE FROM dependencies WHERE project_path = ?').run(this.projectPath);
        this.db.prepare('DELETE FROM entry_points WHERE project_path = ?').run(this.projectPath);
        this.db.prepare('DELETE FROM stats WHERE project_path = ?').run(this.projectPath);
        this.db.prepare('DELETE FROM symbols WHERE project_path = ?').run(this.projectPath);
        this.db.prepare('DELETE FROM graph_edges WHERE project_path = ?').run(this.projectPath);
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
    if (!this.isValidTableName(tableName)) {
      return 0;
    }
    try {
      const result = this.db.prepare(`SELECT COUNT(*) as count FROM "${tableName}"`).get() as { count: number };
      return result.count;
    } catch {
      return 0;
    }
  }

  /**
   * Query a table with pagination.
   */
  queryTable(tableName: string, limit: number, offset: number): unknown[] {
    if (!this.isValidTableName(tableName)) {
      return [];
    }
    try {
      return this.db.prepare(`
        SELECT * FROM "${tableName}"
        LIMIT ? OFFSET ?
      `).all(limit, offset);
    } catch (error) {
      console.error(`Error querying table ${tableName}:`, error);
      return [];
    }
  }

  private isValidTableName(name: string): boolean {
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
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
   * Get the DB file record ID for a given file path.
   * Returns null if the file is not in the database.
   */
  getFileId(filePath: string): number | null {
    const result = this.db.prepare(`
      SELECT id FROM files WHERE project_path = ? AND file_path = ?
    `).get(this.projectPath, filePath) as { id: number } | undefined;
    return result?.id ?? null;
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

  // ==========================================================================
  // Keyword Index Operations
  // ==========================================================================

  /**
   * Save keyword index to database.
   * 
   * @param index - Map of keyword -> file paths
   */
  saveKeywordIndex(index: Map<string, string[]>): void {
    this.runWithRetry(() => {
      const transaction = this.db.transaction(() => {
        const now = Date.now();

        // Clear existing index for this project
        this.db.prepare(`
          DELETE FROM keyword_index WHERE project_path = ?
        `).run(this.projectPath);

        // Insert new index
        const insertStmt = this.db.prepare(`
          INSERT INTO keyword_index (keyword, file_path, project_path, updated_at)
          VALUES (?, ?, ?, ?)
        `);

        for (const [keyword, files] of index) {
          for (const filePath of files) {
            insertStmt.run(keyword, filePath, this.projectPath, now);
          }
        }
      });

      transaction();
    });
  }

  /**
   * Load keyword index from database.
   * 
   * @returns Map of keyword -> file paths, or null if not found
   */
  loadKeywordIndex(): Map<string, string[]> | null {
    const rows = this.db.prepare(`
      SELECT keyword, file_path FROM keyword_index WHERE project_path = ?
    `).all(this.projectPath) as Array<{ keyword: string; file_path: string }>;

    if (rows.length === 0) {
      return null;
    }

    const index = new Map<string, string[]>();
    for (const row of rows) {
      const existing = index.get(row.keyword) || [];
      existing.push(row.file_path);
      index.set(row.keyword, existing);
    }

    return index;
  }

  /**
   * Get files that have been modified since a given timestamp.
   * Used by orchestrator for change detection.
   * 
   * @param sinceTimestamp - Unix timestamp in milliseconds
   * @returns Array of changed files with their change info
   */
  getChangedFilesSince(sinceTimestamp: number): Array<{
    path: string;
    lastIndexed: number;
    contentChanged: boolean;
  }> {
    const rows = this.db.prepare(`
      SELECT relative_path, last_indexed, content_hash
      FROM files 
      WHERE project_path = ? AND last_indexed > ?
      ORDER BY last_indexed DESC
    `).all(this.projectPath, sinceTimestamp) as Array<{
      relative_path: string;
      last_indexed: number;
      content_hash: string;
    }>;

    return rows.map(row => ({
      path: row.relative_path,
      lastIndexed: row.last_indexed,
      contentChanged: true, // If it's in the result, content changed
    }));
  }

  /**
   * Get the last scan time for this project.
   */
  getLastScanTime(): number {
    const stats = this.getStats();
    return stats?.last_scan || 0;
  }

  // ==========================================================================
  // Preferences Operations
  // ==========================================================================

  /**
   * Set a preference value.
   */
  setPreference(key: string, value: string): void {
    this.runWithRetry(() => {
      this.db.prepare(`
        INSERT OR REPLACE INTO preferences (project_path, key, value, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(this.projectPath, key, value, Date.now());
    });
  }

  /**
   * Get a preference value.
   */
  getPreference(key: string): string | null {
    const result = this.db.prepare(`
      SELECT value FROM preferences WHERE project_path = ? AND key = ?
    `).get(this.projectPath, key) as { value: string } | undefined;
    return result?.value ?? null;
  }

  /**
   * Get all preferences for this project.
   */
  getAllPreferences(): Record<string, string> {
    const rows = this.db.prepare(`
      SELECT key, value FROM preferences WHERE project_path = ?
    `).all(this.projectPath) as Array<{ key: string; value: string }>;
    
    const prefs: Record<string, string> = {};
    for (const row of rows) {
      prefs[row.key] = row.value;
    }
    return prefs;
  }

  // ==========================================================================
  // Selector History Operations
  // ==========================================================================

  /**
   * Record a successful selector usage.
   */
  recordSelectorSuccess(elementDescription: string, selector: string, selectorType: string): void {
    this.runWithRetry(() => {
      const now = Date.now();
      const existing = this.db.prepare(`
        SELECT id, success_count FROM selector_history 
        WHERE project_path = ? AND element_description = ? AND selector = ?
      `).get(this.projectPath, elementDescription, selector) as { id: number; success_count: number } | undefined;

      if (existing) {
        this.db.prepare(`
          UPDATE selector_history 
          SET success_count = ?, last_used = ?
          WHERE id = ?
        `).run(existing.success_count + 1, now, existing.id);
      } else {
        this.db.prepare(`
          INSERT INTO selector_history (project_path, element_description, selector, selector_type, success_count, last_used, created_at)
          VALUES (?, ?, ?, ?, 1, ?, ?)
        `).run(this.projectPath, elementDescription, selector, selectorType, now, now);
      }
    });
  }

  /**
   * Record a failed selector usage.
   * Inserts a row on first-ever failure so "this selector never works" is
   * observable rather than silently dropped.
   */
  recordSelectorFailure(
    elementDescription: string,
    selector: string,
    selectorType: string = "other",
  ): void {
    this.runWithRetry(() => {
      const now = Date.now();
      const existing = this.db.prepare(`
        SELECT id, failure_count FROM selector_history 
        WHERE project_path = ? AND element_description = ? AND selector = ?
      `).get(this.projectPath, elementDescription, selector) as { id: number; failure_count: number } | undefined;

      if (existing) {
        this.db.prepare(`
          UPDATE selector_history 
          SET failure_count = ?, last_used = ?
          WHERE id = ?
        `).run(existing.failure_count + 1, now, existing.id);
      } else {
        this.db.prepare(`
          INSERT INTO selector_history (project_path, element_description, selector, selector_type, success_count, failure_count, last_used, created_at)
          VALUES (?, ?, ?, ?, 0, 1, ?, ?)
        `).run(this.projectPath, elementDescription, selector, selectorType, now, now);
      }
    });
  }

  /**
   * Get the best selector for an element based on success/failure ratio.
   */
  getBestSelector(elementDescription: string): { selector: string; selectorType: string; confidence: number } | null {
    const result = this.db.prepare(`
      SELECT selector, selector_type, success_count, failure_count
      FROM selector_history
      WHERE project_path = ? AND element_description = ?
      ORDER BY (success_count - failure_count) DESC, last_used DESC
      LIMIT 1
    `).get(this.projectPath, elementDescription) as { 
      selector: string; 
      selector_type: string; 
      success_count: number; 
      failure_count: number 
    } | undefined;

    if (!result) return null;

    const total = result.success_count + result.failure_count;
    const confidence = total > 0 ? result.success_count / total : 0;

    return {
      selector: result.selector,
      selectorType: result.selector_type,
      confidence,
    };
  }

  /**
   * Get all successful selectors (for prompt context).
   */
  getSuccessfulSelectors(limit = 20): Array<{ element: string; selector: string; type: string; confidence: number }> {
    const rows = this.db.prepare(`
      SELECT element_description, selector, selector_type, success_count, failure_count
      FROM selector_history
      WHERE project_path = ? AND success_count > failure_count
      ORDER BY (success_count - failure_count) DESC, last_used DESC
      LIMIT ?
    `).all(this.projectPath, limit) as Array<{
      element_description: string;
      selector: string;
      selector_type: string;
      success_count: number;
      failure_count: number;
    }>;

    return rows.map(row => ({
      element: row.element_description,
      selector: row.selector,
      type: row.selector_type,
      confidence: row.success_count / (row.success_count + row.failure_count),
    }));
  }

  // ==========================================================================
  // Test Outcomes Operations
  // ==========================================================================

  /**
   * Record a newly generated test.
   */
  recordTestGenerated(testFile: string, testName: string, sourcePrompt: string, generatedCode: string): number {
    const result = this.runWithRetry(() => {
      return this.db.prepare(`
        INSERT INTO test_outcomes (project_path, test_file, test_name, source_prompt, generated_code, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)
      `).run(this.projectPath, testFile, testName, sourcePrompt, generatedCode, Date.now());
    });
    return Number(result.lastInsertRowid);
  }

  /**
   * Record the result of running a test.
   */
  recordTestResult(
    testId: number, 
    status: 'passed' | 'failed' | 'error' | 'timeout', 
    executionTimeMs?: number,
    errorMessage?: string,
    failingSelector?: string
  ): void {
    this.runWithRetry(() => {
      this.db.prepare(`
        UPDATE test_outcomes 
        SET status = ?, execution_time_ms = ?, error_message = ?, failing_selector = ?, last_run = ?, retry_count = retry_count + 1
        WHERE id = ?
      `).run(status, executionTimeMs ?? null, errorMessage ?? null, failingSelector ?? null, Date.now(), testId);
    });
  }

  /**
   * Get recent test failures.
   */
  getRecentFailures(limit = 10): Array<{
    id: number;
    testFile: string;
    testName: string;
    errorMessage: string | null;
    failingSelector: string | null;
    lastRun: number;
  }> {
    const rows = this.db.prepare(`
      SELECT id, test_file, test_name, error_message, failing_selector, last_run
      FROM test_outcomes
      WHERE project_path = ? AND status IN ('failed', 'error')
      ORDER BY last_run DESC
      LIMIT ?
    `).all(this.projectPath, limit) as Array<{
      id: number;
      test_file: string;
      test_name: string;
      error_message: string | null;
      failing_selector: string | null;
      last_run: number;
    }>;

    return rows.map(row => ({
      id: row.id,
      testFile: row.test_file,
      testName: row.test_name,
      errorMessage: row.error_message,
      failingSelector: row.failing_selector,
      lastRun: row.last_run,
    }));
  }

  /**
   * Get a test outcome by ID.
   */
  getTestOutcome(testId: number): {
    id: number;
    testFile: string;
    testName: string;
    sourcePrompt: string;
    generatedCode: string;
    status: string;
    errorMessage: string | null;
  } | null {
    const result = this.db.prepare(`
      SELECT id, test_file, test_name, source_prompt, generated_code, status, error_message
      FROM test_outcomes
      WHERE id = ?
    `).get(testId) as {
      id: number;
      test_file: string;
      test_name: string;
      source_prompt: string;
      generated_code: string;
      status: string;
      error_message: string | null;
    } | undefined;

    if (!result) return null;

    return {
      id: result.id,
      testFile: result.test_file,
      testName: result.test_name,
      sourcePrompt: result.source_prompt,
      generatedCode: result.generated_code,
      status: result.status,
      errorMessage: result.error_message,
    };
  }

  /**
   * Record which source files a generated test covers.
   */
  recordTestSourceFiles(testFile: string, sourceFiles: string[]): void {
    this.runWithRetry(() => {
      const transaction = this.db.transaction(() => {
        const now = Date.now();
        const stmt = this.db.prepare(`
          INSERT OR IGNORE INTO test_source_map (project_path, test_file, source_file, created_at)
          VALUES (?, ?, ?, ?)
        `);
        for (const src of sourceFiles) {
          stmt.run(this.projectPath, testFile, src, now);
        }
      });
      transaction();
    });
  }

  /**
   * Given a list of changed source files, return the test files that cover them.
   * Uses both the explicit test_source_map and the dependency graph (dependents).
   */
  getAffectedTests(changedSourceFiles: string[]): Array<{
    testFile: string;
    reason: 'source_map' | 'dependency';
    sourceFile: string;
  }> {
    if (changedSourceFiles.length === 0) return [];

    const results: Array<{ testFile: string; reason: 'source_map' | 'dependency'; sourceFile: string }> = [];
    const seen = new Set<string>();

    for (const srcFile of changedSourceFiles) {
      const mapped = this.db.prepare(`
        SELECT test_file FROM test_source_map
        WHERE project_path = ? AND source_file = ?
      `).all(this.projectPath, srcFile) as Array<{ test_file: string }>;

      for (const row of mapped) {
        const key = `${row.test_file}::${srcFile}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ testFile: row.test_file, reason: 'source_map', sourceFile: srcFile });
        }
      }

      const dependents = this.db.prepare(`
        SELECT source_file FROM dependencies
        WHERE project_path = ? AND target_file = ?
      `).all(this.projectPath, srcFile) as Array<{ source_file: string }>;

      for (const dep of dependents) {
        if (this.isTestFilePath(dep.source_file)) {
          const key = `${dep.source_file}::${srcFile}`;
          if (!seen.has(key)) {
            seen.add(key);
            results.push({ testFile: dep.source_file, reason: 'dependency', sourceFile: srcFile });
          }
        }
      }
    }

    return results;
  }

  private isTestFilePath(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return /\.(spec|test|e2e)\.[jt]sx?$/.test(lower)
      || lower.includes('/tests/')
      || lower.includes('/test/')
      || lower.includes('/__tests__/')
      || lower.includes('/e2e/');
  }

  // ==========================================================================
  // Symbol Graph Operations
  // ==========================================================================

  /**
   * Replace all symbols for a single file. Atomic: deletes prior rows, then
   * inserts the new set in one transaction.
   */
  replaceFileSymbols(filePath: string, symbols: ParsedSymbol[]): void {
    this.runWithRetry(() => {
      const transaction = this.db.transaction(() => {
        this.replaceFileSymbolsInTransaction(filePath, symbols, Date.now());
      });
      transaction();
    });
  }

  /**
   * Internal helper used inside a larger transaction. Does NOT open its own
   * transaction — caller is responsible for atomicity.
   */
  private replaceFileSymbolsInTransaction(filePath: string, symbols: ParsedSymbol[], now: number): void {
    this.db.prepare(`
      DELETE FROM symbols WHERE project_path = ? AND file_path = ?
    `).run(this.projectPath, filePath);

    if (symbols.length === 0) return;

    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO symbols (
        project_path, file_path, name, kind, start_line, end_line,
        is_exported, is_async, parent, signature, callees, rendered, route_meta, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const s of symbols) {
      insert.run(
        this.projectPath,
        filePath,
        s.name,
        s.kind,
        s.startLine,
        s.endLine,
        s.isExported ? 1 : 0,
        s.isAsync ? 1 : 0,
        s.parent ?? null,
        s.signature ?? null,
        s.callees && s.callees.length ? JSON.stringify(s.callees) : null,
        s.rendered && s.rendered.length ? JSON.stringify(s.rendered) : null,
        s.routeMeta ? JSON.stringify(s.routeMeta) : null,
        now,
      );
    }
  }

  /**
   * Get all symbols defined in a file.
   */
  getFileSymbols(filePath: string): ParsedSymbol[] {
    const rows = this.db.prepare(`
      SELECT name, kind, start_line, end_line, is_exported, is_async, parent, signature, callees, rendered, route_meta
      FROM symbols
      WHERE project_path = ? AND file_path = ?
      ORDER BY start_line ASC
    `).all(this.projectPath, filePath) as Array<{
      name: string;
      kind: string;
      start_line: number;
      end_line: number;
      is_exported: number;
      is_async: number;
      parent: string | null;
      signature: string | null;
      callees: string | null;
      rendered: string | null;
      route_meta: string | null;
    }>;

    return rows.map((row) => ({
      name: row.name,
      kind: row.kind as SymbolKind,
      startLine: row.start_line,
      endLine: row.end_line,
      isExported: row.is_exported === 1,
      isAsync: row.is_async === 1,
      parent: row.parent ?? undefined,
      signature: row.signature ?? undefined,
      callees: row.callees ? safeJsonArray(row.callees) : undefined,
      rendered: row.rendered ? safeJsonArray(row.rendered) : undefined,
      routeMeta: row.route_meta ? safeJsonObject<ParsedSymbol['routeMeta']>(row.route_meta) : undefined,
    }));
  }

  /**
   * Find symbols by name (exact or LIKE), optionally filtered by kind.
   * Useful for resolving "function X is referenced" → which symbol(s) it points to.
   */
  findSymbolsByName(name: string, opts?: { kinds?: SymbolKind[]; like?: boolean; limit?: number }): Array<{
    file: string;
    symbol: ParsedSymbol;
  }> {
    const limit = opts?.limit ?? 25;
    const op = opts?.like ? 'LIKE' : '=';
    const params: Array<string | number> = [this.projectPath, name];

    let sql = `
      SELECT file_path, name, kind, start_line, end_line, is_exported, is_async, parent, signature, callees, rendered, route_meta
      FROM symbols
      WHERE project_path = ? AND name ${op} ?
    `;

    if (opts?.kinds && opts.kinds.length > 0) {
      const placeholders = opts.kinds.map(() => '?').join(',');
      sql += ` AND kind IN (${placeholders})`;
      params.push(...opts.kinds);
    }

    sql += ` LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<{
      file_path: string;
      name: string;
      kind: string;
      start_line: number;
      end_line: number;
      is_exported: number;
      is_async: number;
      parent: string | null;
      signature: string | null;
      callees: string | null;
      rendered: string | null;
      route_meta: string | null;
    }>;

    return rows.map((row) => ({
      file: row.file_path,
      symbol: {
        name: row.name,
        kind: row.kind as SymbolKind,
        startLine: row.start_line,
        endLine: row.end_line,
        isExported: row.is_exported === 1,
        isAsync: row.is_async === 1,
        parent: row.parent ?? undefined,
        signature: row.signature ?? undefined,
        callees: row.callees ? safeJsonArray(row.callees) : undefined,
        rendered: row.rendered ? safeJsonArray(row.rendered) : undefined,
        routeMeta: row.route_meta ? safeJsonObject<ParsedSymbol['routeMeta']>(row.route_meta) : undefined,
      },
    }));
  }

  /**
   * Replace all edges originating from a given source file. Idempotent for
   * incremental updates — caller passes the current edges for the file.
   */
  replaceFileEdges(sourceFile: string, edges: GraphEdge[], kinds?: EdgeKind[]): void {
    this.runWithRetry(() => {
      const transaction = this.db.transaction(() => {
        this.replaceFileEdgesInTransaction(sourceFile, edges, Date.now(), kinds);
      });
      transaction();
    });
  }

  private replaceFileEdgesInTransaction(
    sourceFile: string,
    edges: GraphEdge[],
    now: number,
    kinds?: EdgeKind[],
  ): void {
    // By default we replace every static_ast edge originating from this file.
    // Runtime/test_run edges live alongside and are NOT touched here.
    if (kinds && kinds.length > 0) {
      const placeholders = kinds.map(() => '?').join(',');
      this.db.prepare(`
        DELETE FROM graph_edges
        WHERE project_path = ? AND source_file = ? AND kind IN (${placeholders}) AND provenance = 'static_ast'
      `).run(this.projectPath, sourceFile, ...kinds);
    } else {
      this.db.prepare(`
        DELETE FROM graph_edges WHERE project_path = ? AND source_file = ? AND provenance = 'static_ast'
      `).run(this.projectPath, sourceFile);
    }

    if (edges.length === 0) return;

    const insert = this.db.prepare(`
      INSERT INTO graph_edges (
        project_path, kind, source_file, target_file, source_symbol, target_symbol,
        provenance, confidence, evidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const e of edges) {
      insert.run(
        this.projectPath,
        e.kind,
        e.sourceFile,
        e.targetFile,
        e.sourceSymbol ?? null,
        e.targetSymbol ?? null,
        e.provenance,
        e.confidence,
        e.evidence ? JSON.stringify(e.evidence) : null,
        now,
      );
    }
  }

  /**
   * Add edges without removing existing ones. Used by runtime/coverage feedback.
   */
  addEdges(edges: GraphEdge[]): void {
    if (edges.length === 0) return;
    this.runWithRetry(() => {
      const transaction = this.db.transaction(() => {
        const insert = this.db.prepare(`
          INSERT INTO graph_edges (
            project_path, kind, source_file, target_file, source_symbol, target_symbol,
            provenance, confidence, evidence, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const now = Date.now();
        for (const e of edges) {
          insert.run(
            this.projectPath,
            e.kind,
            e.sourceFile,
            e.targetFile,
            e.sourceSymbol ?? null,
            e.targetSymbol ?? null,
            e.provenance,
            e.confidence,
            e.evidence ? JSON.stringify(e.evidence) : null,
            now,
          );
        }
      });
      transaction();
    });
  }

  /**
   * Find edges that target any of the given files. Used to resolve
   * "what depends on these changed files" with explicit provenance.
   */
  getIncomingEdges(targetFiles: string[], opts?: { kinds?: EdgeKind[] }): GraphEdge[] {
    if (targetFiles.length === 0) return [];

    const placeholders = targetFiles.map(() => '?').join(',');
    let sql = `
      SELECT kind, source_file, target_file, source_symbol, target_symbol, provenance, confidence, evidence
      FROM graph_edges
      WHERE project_path = ? AND target_file IN (${placeholders})
    `;
    const params: Array<string | number> = [this.projectPath, ...targetFiles];

    if (opts?.kinds && opts.kinds.length > 0) {
      const kindPlaceholders = opts.kinds.map(() => '?').join(',');
      sql += ` AND kind IN (${kindPlaceholders})`;
      params.push(...opts.kinds);
    }

    sql += ` ORDER BY confidence DESC`;

    const rows = this.db.prepare(sql).all(...params) as Array<{
      kind: string;
      source_file: string;
      target_file: string;
      source_symbol: string | null;
      target_symbol: string | null;
      provenance: string;
      confidence: number;
      evidence: string | null;
    }>;

    return rows.map((row) => ({
      kind: row.kind as EdgeKind,
      sourceFile: row.source_file,
      targetFile: row.target_file,
      sourceSymbol: row.source_symbol ?? undefined,
      targetSymbol: row.target_symbol ?? undefined,
      provenance: row.provenance as EdgeProvenance,
      confidence: row.confidence,
      evidence: row.evidence ? safeJsonObject<GraphEdge['evidence']>(row.evidence) : undefined,
    }));
  }

  /**
   * Compact stats for the symbol graph (used by `raiken status` / dashboard).
   */
  getSymbolGraphStats(): { symbols: number; edges: number; edgesByKind: Record<string, number> } {
    const sym = this.db.prepare(`SELECT COUNT(*) as c FROM symbols WHERE project_path = ?`).get(this.projectPath) as { c: number };
    const edg = this.db.prepare(`SELECT COUNT(*) as c FROM graph_edges WHERE project_path = ?`).get(this.projectPath) as { c: number };
    const byKind = this.db.prepare(`
      SELECT kind, COUNT(*) as c FROM graph_edges WHERE project_path = ? GROUP BY kind
    `).all(this.projectPath) as Array<{ kind: string; c: number }>;

    return {
      symbols: sym.c,
      edges: edg.c,
      edgesByKind: Object.fromEntries(byKind.map((r) => [r.kind, r.c])),
    };
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
      version: CodeGraphDB.SCHEMA_VERSION,
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
   * Prune old selector history and test outcomes to prevent unbounded growth.
   */
  pruneHistory(maxSelectors = 500, maxOutcomes = 200): void {
    this.runWithRetry(() => {
      this.db.exec(`
        DELETE FROM selector_history WHERE id NOT IN (
          SELECT id FROM selector_history ORDER BY last_used DESC LIMIT ${maxSelectors}
        );
        DELETE FROM test_outcomes WHERE id NOT IN (
          SELECT id FROM test_outcomes ORDER BY created_at DESC LIMIT ${maxOutcomes}
        );
      `);
    });
  }

  /**
   * Generate a content hash for a file.
   */
  static hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }
}

function safeJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function safeJsonObject<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
