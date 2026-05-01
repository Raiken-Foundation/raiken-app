import * as parser from '@babel/parser';
import type { ParserPlugin } from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import type { ParsedFile, CodeChunk, ParsedFunction, ParsedClass, ParsedType } from '../types';
import { getParamName, isExportedNode } from '../utils';

/**
 * Determine if file is TypeScript based on extension.
 */
function isTypeScriptFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return ['ts', 'tsx', 'mts', 'cts'].includes(ext);
}

/**
 * Determine if file uses JSX based on extension.
 */
function isJsxFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return ['jsx', 'tsx'].includes(ext);
}

/**
 * Get appropriate Babel parser plugins based on file type.
 */
function getParserPlugins(filename: string): ParserPlugin[] {
  const plugins: ParserPlugin[] = [
    ['decorators', { decoratorsBeforeExport: true }],  // Modern decorator syntax
    'classProperties',
    'classPrivateProperties',
    'classPrivateMethods',
    'classStaticBlock',
    'privateIn',
    'dynamicImport',
    'exportDefaultFrom',
    'exportNamespaceFrom',
    'importMeta',
    'topLevelAwait',
    'optionalChaining',
    'nullishCoalescingOperator',
    'logicalAssignment',
    'numericSeparator',
    'bigInt',
    ['importAttributes', { deprecatedAssertSyntax: true }],
  ];

  // Add TypeScript plugin for TS files
  if (isTypeScriptFile(filename)) {
    plugins.push('typescript');
  }

  // Always add JSX support - many JS files use JSX without the explicit extension
  plugins.push('jsx');

  return plugins;
}

/**
 * Parse JavaScript/TypeScript file into structured AST representation.
 * Supports: .js, .jsx, .ts, .tsx, .mjs, .cjs, .mts, .cts
 * 
 * @param code - The code to parse.
 * @param filename - The filename (used to determine parser plugins).
 * @returns The parsed file structure.
 */
/**
 * Parse source code into structured format + complete Babel AST.
 * Always returns both simplified structure (for embeddings) and complete Babel AST (for test generation).
 */
export function parseSourceFile(code: string, filename = 'unknown.js'): import('../types').ParsedFileWithAst {
  const result: ParsedFile = {
    functions: [],
    classes: [],
    imports: [],
    exports: [],
    types: []
  };

  let astTree: unknown;

  try {
    // Parse the code into an AST with appropriate plugins
    // Use 'unambiguous' to auto-detect module vs script based on import/export presence
    const ast = parser.parse(code, {
      sourceType: 'unambiguous',
      plugins: getParserPlugins(filename)
    });

    // Store complete AST for advanced features (test generation, refactoring, etc.)
    astTree = ast;

    // Traverse the AST
    traverse(ast, {
      // Function declarations: function foo() {}
      FunctionDeclaration(path) {
        const node = path.node;
        if (t.isIdentifier(node.id)) {
          result.functions.push({
            name: node.id.name,
            params: node.params.map(p => getParamName(p)),
            isAsync: node.async,
            isExported: isExportedNode(path),
            line: node.loc?.start.line || 0
          });
        }
      },

      // Arrow functions and function expressions: const foo = () => {}
      VariableDeclarator(path) {
        const node = path.node;
        if (t.isIdentifier(node.id) && 
            (t.isArrowFunctionExpression(node.init) || t.isFunctionExpression(node.init))) {
          
          // Check both parent and grandparent for export
          // VariableDeclarator → VariableDeclaration → ExportNamedDeclaration
          const isExported = isExportedNode(path.parentPath) || 
                           (path.parentPath?.parentPath ? isExportedNode(path.parentPath.parentPath) : false);
          
          result.functions.push({
            name: node.id.name,
            params: node.init.params.map(p => getParamName(p)),
            isAsync: node.init.async,
            isExported,
            line: node.loc?.start.line || 0
          });
        }
      },

      // Class declarations: class Foo {}
      ClassDeclaration(path) {
        const node = path.node;
        if (t.isIdentifier(node.id)) {
          const methods: string[] = [];
          const properties: string[] = [];

          node.body.body.forEach(member => {
            // Methods
            if (t.isClassMethod(member)) {
              const key = member.key;
              if (t.isIdentifier(key)) {
                methods.push(key.name);
              } else if (t.isPrivateName(key)) {
                // Private methods: #method
                methods.push(`#${(key as t.PrivateName).id.name}`);
              }
            }
            // Properties  
            else if (t.isClassProperty(member)) {
              const key = member.key;
              if (t.isIdentifier(key)) {
                properties.push(key.name);
              } else if (t.isPrivateName(key)) {
                // Private properties: #prop
                properties.push(`#${(key as t.PrivateName).id.name}`);
              }
            }
            // Class private properties (TypeScript)
            else if (t.isClassPrivateProperty(member)) {
              const key = member.key;
              if (t.isPrivateName(key)) {
                properties.push(`#${(key as t.PrivateName).id.name}`);
              }
            }
          });

          result.classes.push({
            name: node.id.name,
            methods,
            properties,
            isExported: isExportedNode(path),
            line: node.loc?.start.line || 0
          });
        }
      },

      // Import declarations: import { foo } from 'bar'
      ImportDeclaration(path) {
        const node = path.node;
        
        // Separate import types
        const defaultSpec = node.specifiers.find(s => t.isImportDefaultSpecifier(s));
        const namespaceSpec = node.specifiers.find(s => t.isImportNamespaceSpecifier(s));
        const namedSpecs = node.specifiers.filter(s => t.isImportSpecifier(s));

        result.imports.push({
          source: node.source.value,
          defaultImport: defaultSpec ? (defaultSpec as t.ImportDefaultSpecifier).local.name : undefined,
          namespaceImport: namespaceSpec ? (namespaceSpec as t.ImportNamespaceSpecifier).local.name : undefined,
          namedImports: namedSpecs.map(s => (s as t.ImportSpecifier).local.name),
          isTypeOnly: node.importKind === 'type'
        });
      },

      // Named export declarations: export { foo } or export function foo() {}
      ExportNamedDeclaration(path) {
        const node = path.node;

        // Handle re-exports: export { foo, bar } from './module'
        // or local exports: export { foo, bar }
        if (node.specifiers && node.specifiers.length > 0) {
          node.specifiers.forEach(spec => {
            if (t.isExportSpecifier(spec)) {
              const exportedName = t.isIdentifier(spec.exported) 
                ? spec.exported.name 
                : t.isStringLiteral(spec.exported) 
                  ? spec.exported.value 
                  : '<unknown>';
              result.exports.push(exportedName);
            }
          });
          return;
        }

        // Handle inline exports: export function foo() {}
        const decl = node.declaration;
        if (!decl) return;

        if (t.isFunctionDeclaration(decl) && decl.id) {
          result.exports.push(decl.id.name);
        } else if (t.isClassDeclaration(decl) && decl.id) {
          result.exports.push(decl.id.name);
        } else if (t.isVariableDeclaration(decl)) {
          decl.declarations.forEach(d => {
            if (t.isIdentifier(d.id)) {
              result.exports.push(d.id.name);
            }
          });
        } else if (t.isTSTypeAliasDeclaration(decl) && t.isIdentifier(decl.id)) {
          result.exports.push(decl.id.name);
        } else if (t.isTSInterfaceDeclaration(decl) && t.isIdentifier(decl.id)) {
          result.exports.push(decl.id.name);
        } else if (t.isTSEnumDeclaration(decl) && t.isIdentifier(decl.id)) {
          result.exports.push(decl.id.name);
        }
      },

      // Default exports: export default Foo
      ExportDefaultDeclaration(path) {
        const node = path.node;
        let exportName = 'default';
        
        // Try to capture the name for better debugging
        if (t.isIdentifier(node.declaration)) {
          exportName = `default (${node.declaration.name})`;
        } else if (t.isFunctionDeclaration(node.declaration) && node.declaration.id) {
          exportName = `default (${node.declaration.id.name})`;
        } else if (t.isClassDeclaration(node.declaration) && node.declaration.id) {
          exportName = `default (${node.declaration.id.name})`;
        }
        
        result.exports.push(exportName);
      },

      // TypeScript type alias: type Foo = ...
      TSTypeAliasDeclaration(path) {
        const node = path.node;
        if (t.isIdentifier(node.id)) {
          result.types.push({
            name: node.id.name,
            kind: 'type',
            isExported: isExportedNode(path),
            line: node.loc?.start.line || 0
          });
        }
      },

      // TypeScript interface: interface Foo {}
      TSInterfaceDeclaration(path) {
        const node = path.node;
        if (t.isIdentifier(node.id)) {
          result.types.push({
            name: node.id.name,
            kind: 'interface',
            isExported: isExportedNode(path),
            line: node.loc?.start.line || 0
          });
        }
      },

      // TypeScript enum: enum Foo {}
      TSEnumDeclaration(path) {
        const node = path.node;
        if (t.isIdentifier(node.id)) {
          result.types.push({
            name: node.id.name,
            kind: 'enum',
            isExported: isExportedNode(path),
            line: node.loc?.start.line || 0
          });
        }
      }
    });

  } catch (error) {
    // Provide detailed error information
    const err = error as Error & { loc?: { line: number } };
    const line = err.loc?.line || 0;
    const message = err.message;
    const sanitizedFilename = filename.replace(/\n/g, '\\n');  // Sanitize for logging
    
    throw new Error(
      `Parse error in ${sanitizedFilename}${line ? `:${line}` : ''}: ${message}`
    );
  }

  // Always return both parsed structure (for embeddings) and complete AST (for test generation)
  return { parsed: result, ast: astTree };
}

/**
 * Generate human-readable summary of parsed file.
 * Useful for debugging and logging.
 */
export function summarizeParsedFile(parsed: ParsedFile): string {
  const lines: string[] = [];
  
  if (parsed.imports.length > 0) {
    lines.push(`Imports: ${parsed.imports.length}`);
    parsed.imports.forEach(imp => {
      const parts: string[] = [];
      if (imp.defaultImport) parts.push(imp.defaultImport);
      if (imp.namespaceImport) parts.push(`* as ${imp.namespaceImport}`);
      if (imp.namedImports.length > 0) parts.push(`{ ${imp.namedImports.join(', ')} }`);
      
      const typeOnly = imp.isTypeOnly ? ' (type-only)' : '';
      lines.push(`  - from "${imp.source}": ${parts.join(', ')}${typeOnly}`);
    });
  }
  
  if (parsed.functions.length > 0) {
    lines.push(`\nFunctions: ${parsed.functions.length}`);
    parsed.functions.forEach(fn => {
      const exported = fn.isExported ? 'export ' : '';
      const async = fn.isAsync ? 'async ' : '';
      lines.push(`  - ${exported}${async}${fn.name}(${fn.params.join(', ')})`);
    });
  }
  
  if (parsed.classes.length > 0) {
    lines.push(`\nClasses: ${parsed.classes.length}`);
    parsed.classes.forEach(cls => {
      const exported = cls.isExported ? 'export ' : '';
      lines.push(`  - ${exported}class ${cls.name}`);
      if (cls.methods.length > 0) {
        lines.push(`    Methods: ${cls.methods.join(', ')}`);
      }
      if (cls.properties.length > 0) {
        lines.push(`    Properties: ${cls.properties.join(', ')}`);
      }
    });
  }
  
  if (parsed.types.length > 0) {
    lines.push(`\nTypes: ${parsed.types.length}`);
    parsed.types.forEach(type => {
      const exported = type.isExported ? 'export ' : '';
      lines.push(`  - ${exported}${type.kind} ${type.name}`);
    });
  }
  
  if (parsed.exports.length > 0) {
    lines.push(`\nExports: ${parsed.exports.join(', ')}`);
  }
  
  return lines.join('\n');
}

/**
 * Convert parsed AST to searchable text format for embeddings.
 * This creates a human-readable representation of the code structure.
 * 
 * @param parsed - The parsed file structure
 * @param filePath - The file path (for context)
 * @returns Searchable text representation
 */
export function astToSearchableText(parsed: ParsedFile, filePath: string): string {
  const chunks = generateCodeChunks(parsed, filePath);
  
  // Add file header
  const lines = [`File: ${filePath}`];
  
  // Convert each chunk to text
  for (const chunk of chunks) {
    const text = chunkToSearchableText(chunk);
    // Remove file path from individual lines (redundant)
    const simplifiedText = text.replace(` in ${filePath}`, '');
    lines.push(simplifiedText);
  }
  
  return lines.join('\n');
}

/**
 * Convert full Babel AST to rich searchable text for embeddings.
 * Extracts complete structural and semantic information for test generation.
 * 
 * @param ast - The complete Babel AST
 * @param filePath - The file path (for context)
 * @param sourceCode - Optional source code for code snippets
 * @returns Rich searchable text with full context
 */
export function fullAstToSearchableText(ast: unknown, filePath: string, sourceCode?: string): string {
  const lines = [`File: ${filePath}\n`];
  const astNode = ast as t.File;
  
  if (!astNode || !astNode.program) {
    return lines.join('\n');
  }
  
  // Traverse AST and extract detailed information
  traverse(astNode, {
    // Function declarations with full context
    FunctionDeclaration(path) {
      const node = path.node;
      if (t.isIdentifier(node.id)) {
        const async = node.async ? 'async ' : '';
        const exported = isExportedNode(path) ? 'export ' : '';
        const params = node.params.map(p => getParamName(p)).join(', ');
        
        lines.push(`${exported}${async}function ${node.id.name}(${params})`);
        
        // Add function body context (first few statements)
        if (node.body && node.body.body.length > 0) {
          const bodyPreview = node.body.body.slice(0, 3).map(stmt => {
            return `  ${t.isReturnStatement(stmt) ? 'returns' : t.isIfStatement(stmt) ? 'if condition' : 'statement'}`;
          }).join('\n');
          lines.push(bodyPreview);
        }
        lines.push('');
      }
    },
    
    // Arrow functions and function expressions
    VariableDeclarator(path) {
      const node = path.node;
      if (t.isIdentifier(node.id) && 
          (t.isArrowFunctionExpression(node.init) || t.isFunctionExpression(node.init))) {
        const async = node.init.async ? 'async ' : '';
        const params = node.init.params.map(p => getParamName(p)).join(', ');
        const exported = isExportedNode(path.parentPath) || (path.parentPath?.parentPath ? isExportedNode(path.parentPath.parentPath) : false) ? 'export ' : '';
        
        lines.push(`${exported}${async}const ${node.id.name} = (${params}) => {...}`);
        lines.push('');
      }
    },
    
    // Classes with full details
    ClassDeclaration(path) {
      const node = path.node;
      if (t.isIdentifier(node.id)) {
        const exported = isExportedNode(path) ? 'export ' : '';
        lines.push(`${exported}class ${node.id.name}`);
        
        // List all methods and properties
        node.body.body.forEach(member => {
          if (t.isClassMethod(member)) {
            const key = member.key;
            let name = 'unknown';
            if (t.isIdentifier(key)) {
              name = key.name;
            } else if (t.isPrivateName(key)) {
              name = `#${(key as t.PrivateName).id.name}`;
            }
            const kind = member.kind === 'constructor' ? 'constructor' : member.kind === 'get' ? 'getter' : member.kind === 'set' ? 'setter' : 'method';
            const async = member.async ? 'async ' : '';
            const params = member.params.map(p => getParamName(p)).join(', ');
            lines.push(`  ${async}${kind} ${name}(${params})`);
          } else if (t.isClassProperty(member)) {
            const key = member.key;
            let name = 'unknown';
            if (t.isIdentifier(key)) {
              name = key.name;
            } else if (t.isPrivateName(key)) {
              name = `#${(key as t.PrivateName).id.name}`;
            }
            lines.push(`  property ${name}`);
          }
        });
        lines.push('');
      }
    },
    
    // Type definitions
    TSInterfaceDeclaration(path) {
      const node = path.node;
      if (t.isIdentifier(node.id)) {
        const exported = isExportedNode(path) ? 'export ' : '';
        lines.push(`${exported}interface ${node.id.name}`);
        
        // List interface members
        if (node.body?.body) {
          node.body.body.slice(0, 5).forEach(member => {
            if (t.isTSPropertySignature(member) && t.isIdentifier(member.key)) {
              lines.push(`  ${member.key.name}: ${member.typeAnnotation ? 'type' : 'any'}`);
            } else if (t.isTSMethodSignature(member) && t.isIdentifier(member.key)) {
              const params = member.parameters?.map(p => 
                t.isIdentifier(p) ? p.name : 'param'
              ).join(', ') || '';
              lines.push(`  ${member.key.name}(${params})`);
            }
          });
        }
        lines.push('');
      }
    },
    
    TSTypeAliasDeclaration(path) {
      const node = path.node;
      if (t.isIdentifier(node.id)) {
        const exported = isExportedNode(path) ? 'export ' : '';
        lines.push(`${exported}type ${node.id.name} = ...`);
        lines.push('');
      }
    },
    
    TSEnumDeclaration(path) {
      const node = path.node;
      if (t.isIdentifier(node.id)) {
        const exported = isExportedNode(path) ? 'export ' : '';
        lines.push(`${exported}enum ${node.id.name}`);
        
        // List enum members
        node.members.slice(0, 5).forEach(member => {
          if (t.isIdentifier(member.id)) {
            lines.push(`  ${member.id.name}`);
          }
        });
        lines.push('');
      }
    },
    
    // Import statements with full details
    ImportDeclaration(path) {
      const node = path.node;
      const source = node.source.value;
      const specifiers: string[] = [];
      
      node.specifiers.forEach(spec => {
        if (t.isImportDefaultSpecifier(spec)) {
          specifiers.push(spec.local.name);
        } else if (t.isImportNamespaceSpecifier(spec)) {
          specifiers.push(`* as ${spec.local.name}`);
        } else if (t.isImportSpecifier(spec)) {
          specifiers.push(spec.local.name);
        }
      });
      
      if (specifiers.length > 0) {
        lines.push(`import ${specifiers.join(', ')} from "${source}"`);
      }
    },
  });
  
  // If source code is provided, add snippets of key sections
  if (sourceCode) {
    const codeLines = sourceCode.split('\n');
    if (codeLines.length > 0 && codeLines.length < 50) {
      lines.push('\n--- Code Snippet ---');
      lines.push(sourceCode.substring(0, 500)); // First 500 chars
    }
  }
  
  return lines.join('\n');
}

/**
 * Generate individual code chunks from parsed AST.
 * Each chunk represents a searchable unit (function, class, type).
 * 
 * @param parsed - The parsed file structure
 * @param filePath - The file path for context
 * @returns Array of code chunks ready for embedding generation
 */
export function generateCodeChunks(
  parsed: ParsedFile, 
  filePath: string
): CodeChunk[] {
  const chunks: CodeChunk[] = [];

  // Function chunks
  for (const func of parsed.functions) {
    chunks.push({
      type: 'function',
      name: func.name,
      filePath,
      data: func,
      line: func.line,
      isExported: func.isExported,
      isAsync: func.isAsync,
    });
  }

  // Class chunks (class itself + individual methods)
  for (const cls of parsed.classes) {
    // Class chunk
    chunks.push({
      type: 'class',
      name: cls.name,
      filePath,
      data: cls,
      line: cls.line,
      isExported: cls.isExported,
    });

    // Method chunks (as separate searchable units)
    for (const method of cls.methods) {
      chunks.push({
        type: 'function',
        name: `${cls.name}.${method}`,
        filePath,
        data: null, // Methods are strings, no full data
        line: cls.line,
        isExported: cls.isExported,
      });
    }
  }

  // Type chunks
  for (const type of parsed.types) {
    chunks.push({
      type: 'type',
      name: type.name,
      filePath,
      data: type,
      line: type.line,
      isExported: type.isExported,
    });
  }

  return chunks;
}

/**
 * Convert a single code chunk to searchable text format.
 * This creates the embedding-friendly representation.
 * 
 * @param chunk - The code chunk to convert
 * @returns Human-readable text representation
 */
export function chunkToSearchableText(chunk: CodeChunk): string {
  const relativePath = chunk.filePath;

  switch (chunk.type) {
    case 'function':
      if (chunk.data && 'params' in chunk.data) {
        const func = chunk.data as ParsedFunction;
        const asyncPrefix = func.isAsync ? 'async ' : '';
        const params = func.params.join(', ');
        return `${asyncPrefix}function ${chunk.name}(${params}) in ${relativePath}`;
      }
      // Method case (no full data)
      return `method ${chunk.name}() in ${relativePath}`;

    case 'class':
      if (chunk.data && 'methods' in chunk.data) {
        const cls = chunk.data as ParsedClass;
        const methodsInfo = cls.methods.length > 0 
          ? ` with ${cls.methods.length} methods` 
          : '';
        return `class ${chunk.name}${methodsInfo} in ${relativePath}`;
      }
      return `class ${chunk.name} in ${relativePath}`;

    case 'type':
      if (chunk.data && 'kind' in chunk.data) {
        const type = chunk.data as ParsedType;
        return `${type.kind} ${chunk.name} in ${relativePath}`;
      }
      return `type ${chunk.name} in ${relativePath}`;

    case 'file':
      return `File: ${relativePath}`;

    default:
      return `${chunk.name} in ${relativePath}`;
  }
}

