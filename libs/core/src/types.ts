// ============================================================================
// AST Types (Used by ast-parser.ts and code-graph.ts)
// ============================================================================

export interface ParsedFunction {
  name: string;
  params: string[];
  returnType?: string;
  isAsync: boolean;
  isExported: boolean;
  line: number;
}

export interface ParsedClass {
  name: string;
  methods: string[];
  properties: string[];
  isExported: boolean;
  line: number;
}

export interface ParsedImport {
  source: string;
  defaultImport?: string;       
  namespaceImport?: string;      
  namedImports: string[];        
  isTypeOnly?: boolean;          
}

export interface ParsedType {
  name: string;
  kind: 'type' | 'interface' | 'enum';
  isExported: boolean;
  line: number;
}

export interface ParsedFile {
  functions: ParsedFunction[];
  classes: ParsedClass[];
  imports: ParsedImport[];
  exports: string[];
  types: ParsedType[];          
}  

// ============================================================================
// Entry Point Detector
// ============================================================================

  export interface EntryPointResult {
    file: string;
    type: 'explicit' | 'inferred' | 'convention';
    framework?: string;
    reason: string;
    role?: 'main' | 'layout' | 'page' | 'api' | 'middleware' | 'config';
  }
  
  export interface PackageJson {
    main?: string;
    module?: string;
    browser?: string;
    exports?: Record<string, unknown> | string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }
  
  export interface NextConfig {
    pageExtensions?: string[];
    experimental?: {
      appDir?: boolean;
    };
  }

  // ============================================================================
  // Code Graph
  // ============================================================================

  export interface CodeNode {
    filePath: string;          // Absolute path
    relativePath: string;      // Relative to project root
    parsed: ParsedFile;        // AST data (functions, classes, imports, exports)
    imports: string[];         // Files this imports (absolute paths)
    importedBy: string[];      // Files that import this (absolute paths)
    depth: number;             // Distance from entry point
    size: number;              // File size in bytes
    lines: number;             // Total lines of code
    lastModified: number;      // Timestamp (for change detection)
    hash: string;              // Content hash (for diffing)
    treeHash: string;          // Hash of this node + all descendants (for tree change detection)
    meta: {
      extension: string;       // File extension (.ts, .tsx, etc.)
      isTest: boolean;         // Is this a test file?
      isEntry: boolean;        // Is this an entry point?
      hasExports: boolean;     // Does this file export anything?
      hasDefaultExport: boolean; // Has default export?
      complexity: number;      // Simple complexity metric (functions + classes)
    };
  }
  
  export interface GraphStats {
    totalFiles: number;
    totalFunctions: number;
    totalClasses: number;
    lastUpdate: Date;
  }
  
  export interface UpdateEvent {
    type: 'add' | 'change' | 'remove';
    filePath: string;
    affectedFiles: string[];
    timestamp: Date;
  }
  
  export interface CodeGraphOptions {
    maxDepth?: number;
    extensions?: string[];
    excludeDirs?: string[];
    includeTests?: boolean;
    useGitignore?: boolean;
    enableWatch?: boolean;
    onUpdate?: (event: UpdateEvent) => void;
  }
  
