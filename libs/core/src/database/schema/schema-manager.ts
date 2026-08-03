import type { DbAdapter } from "../adapter";

export class SchemaManager {
    constructor(private readonly adapter: DbAdapter) {}

    private getUserVersion(): number {
        const result = this.adapter.db.pragma("user_version", { simple: true }) as number;
        return result;
    }

    private setUserVersion(version: number): void {
        this.adapter.db.pragma(`user_version = ${version}`);
    }

    /**
     * Ensure schema exists and run migrations if needed.
     */
    ensureSchema(): void {
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
        this.ensureTestOutcomeColumns();
        this.ensureDependencyColumns();
        this.ensureFileColumns();
        this.ensureSymbolGraphSchema();
        this.ensureDiscoveredPageColumns();
    }

    /**
     * Idempotently add columns to `test_outcomes` that post-date its creation
     * in `ensureMemorySchema`. `origin` distinguishes agent-generated tests
     * (which carry a source prompt and generated code) from outcomes recorded
     * by plain runners (`raiken test` / `report` / `ci`) for arbitrary specs;
     * runner rows use empty strings for the agent-only NOT NULL columns, since
     * relaxing those would require a full table rebuild for no reader benefit.
     * Must run after `ensureMemorySchema`, which creates the table.
     */
    private ensureTestOutcomeColumns(): void {
        const columns = this.adapter.db.prepare(`PRAGMA table_info(test_outcomes)`).all() as Array<{
            name: string;
        }>;
        if (!columns.some((column) => column.name === "origin")) {
            this.adapter.db.exec(
                `ALTER TABLE test_outcomes ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent'`,
            );
        }
    }

    /**
     * Idempotently add columns to `discovered_pages` that post-date its v4
     * creation. `forms_json` stores the structured form fields discovery
     * extracted from a page (label/type/selector per input) so test generation
     * can reference real form controls instead of guessing them.
     * `captured_authenticated` records whether the crawl that wrote the row was
     * carrying a session, which is what lets cover distinguish "we have pages"
     * from "we have pages from behind the login".
     *
     * The table only exists once the v4 discovery migration has run, so this is
     * a no-op on databases that have never done discovery.
     */
    private ensureDiscoveredPageColumns(): void {
        const tables = this.adapter.db
            .prepare(
                `SELECT name FROM sqlite_master WHERE type='table' AND name='discovered_pages'`,
            )
            .all() as Array<{ name: string }>;
        if (tables.length === 0) return;

        const columnNames = (
            this.adapter.db.prepare(`PRAGMA table_info(discovered_pages)`).all() as Array<{
                name: string;
            }>
        ).map((col) => col.name);

        if (!columnNames.includes("forms_json")) {
            this.adapter.db.exec(`ALTER TABLE discovered_pages ADD COLUMN forms_json TEXT`);
        }

        // Rows that predate the column were crawled before Raiken tracked this,
        // so 0 ("not known to be authenticated") is the correct default: it
        // makes cover re-crawl once with the session rather than trust a
        // snapshot whose provenance nobody recorded.
        if (!columnNames.includes("captured_authenticated")) {
            this.adapter.db.exec(
                `ALTER TABLE discovered_pages ADD COLUMN captured_authenticated INTEGER NOT NULL DEFAULT 0`,
            );
        }
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
        this.adapter.db.transaction(() => {
            this.adapter.db.exec(`
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

            this.adapter.db.exec(`
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

        if (currentVersion < 7) {
            this.migrateToV7();
            this.setUserVersion(7);
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
        this.adapter.db.transaction(() => {
            // Discovered pages table
            this.adapter.db.exec(`
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
            this.adapter.db.exec(`
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
            this.adapter.db.exec(`
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
            this.adapter.db.exec(`
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
        const tableInfo = this.adapter.db
            .prepare(`PRAGMA table_info(discovery_sessions)`)
            .all() as Array<{
            name: string;
        }>;
        const columnNames = tableInfo.map((col) => col.name);

        this.adapter.db.transaction(() => {
            if (!columnNames.includes("max_pages")) {
                this.adapter.db.exec(`ALTER TABLE discovery_sessions ADD COLUMN max_pages INTEGER`);
            }
            if (!columnNames.includes("max_depth")) {
                this.adapter.db.exec(`ALTER TABLE discovery_sessions ADD COLUMN max_depth INTEGER`);
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
        this.adapter.db.transaction(() => {
            const tables = this.adapter.db
                .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
                .all() as Array<{ name: string }>;
            const tableNames = new Set(tables.map((t) => t.name));

            // 1. Create the new generalised table.
            this.adapter.db.exec(`
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
            if (tableNames.has("auth_blockers")) {
                this.adapter.db.exec(`
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
                this.adapter.db.exec(`DROP TABLE auth_blockers;`);
            }

            // 4. Session-scoped resolution memory.
            const sessionInfo = this.adapter.db
                .prepare(`PRAGMA table_info(discovery_sessions)`)
                .all() as Array<{ name: string }>;
            const sessionColumns = new Set(sessionInfo.map((c) => c.name));
            if (!sessionColumns.has("skipped_urls_json")) {
                this.adapter.db.exec(
                    `ALTER TABLE discovery_sessions ADD COLUMN skipped_urls_json TEXT`,
                );
            }
            if (!sessionColumns.has("ignored_categories_json")) {
                this.adapter.db.exec(
                    `ALTER TABLE discovery_sessions ADD COLUMN ignored_categories_json TEXT`,
                );
            }
        })();
    }

    /**
     * Migration to v7 — first-class recorded flows (multi-step navigation /
     * login sequences) persisted for cover and replay.
     */
    private migrateToV7(): void {
        this.adapter.db.transaction(() => {
            this.adapter.db.exec(`
      CREATE TABLE IF NOT EXISTS recorded_flows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_path TEXT NOT NULL,
        name TEXT NOT NULL,
        label TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'discovery',
        last_verified_at INTEGER NOT NULL,
        UNIQUE(project_path, name)
      );

      CREATE INDEX IF NOT EXISTS idx_recorded_flows_project
        ON recorded_flows(project_path);
    `);
        })();
    }

    private ensureFileColumns(): void {
        const tableInfo = this.adapter.db.prepare(`PRAGMA table_info(files)`).all() as Array<{
            name: string;
        }>;
        const columnNames = tableInfo.map((col) => col.name);

        this.adapter.db.transaction(() => {
            if (!columnNames.includes("parsed_ast")) {
                this.adapter.db.exec(`ALTER TABLE files ADD COLUMN parsed_ast TEXT DEFAULT '{}'`);
            }
            if (!columnNames.includes("ast")) {
                this.adapter.db.exec(`ALTER TABLE files ADD COLUMN ast TEXT DEFAULT NULL`);
            }
            if (!columnNames.includes("indexed_via")) {
                this.adapter.db.exec(
                    `ALTER TABLE files ADD COLUMN indexed_via TEXT DEFAULT 'scan'`,
                );
            }
            if (!columnNames.includes("last_modified")) {
                this.adapter.db.exec(
                    `ALTER TABLE files ADD COLUMN last_modified INTEGER DEFAULT 0`,
                );
            }
        })();
    }

    private ensureDependencyColumns(): void {
        const depsInfo = this.adapter.db.prepare(`PRAGMA table_info(dependencies)`).all() as Array<{
            name: string;
        }>;
        if (!depsInfo.some((col) => col.name === "import_type")) {
            this.adapter.db.exec(
                `ALTER TABLE dependencies ADD COLUMN import_type TEXT DEFAULT 'static'`,
            );
        }
    }

    /**
     * Initial schema (v1)
     */
    private createV1Schema(): void {
        this.adapter.db.exec(`
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
        this.adapter.db.transaction(() => {
            // Create embeddings table
            this.adapter.db.exec(`
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
            this.adapter.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
        embedding float[384]
      );
    `);
        })();
    }

    private ensureKeywordIndexSchema(): void {
        this.adapter.db.transaction(() => {
            // Create keyword index table for fast semantic search
            this.adapter.db.exec(`
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
        this.adapter.db.transaction(() => {
            // User preferences (project-level settings)
            this.adapter.db.exec(`
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
            this.adapter.db.exec(`
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
            this.adapter.db.exec(`
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

            this.adapter.db.exec(`
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
}
