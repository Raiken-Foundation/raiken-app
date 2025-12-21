import * as parser from '@babel/parser';
import type { ParserPlugin } from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { ParsedFile } from '../types';
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
    ['decorators', { decoratorsBeforeExport: true }]  // Modern decorator syntax
  ];

  // Add TypeScript plugin for TS files
  if (isTypeScriptFile(filename)) {
    plugins.push('typescript');
  }

  // Add JSX plugin for JSX/TSX files
  if (isJsxFile(filename)) {
    plugins.push('jsx');
  } else {
    // For non-JSX files, we still add JSX support as many JS files use it
    // without the explicit extension
    plugins.push('jsx');
  }

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
export function parseSourceFile(code: string, filename = 'unknown.js'): ParsedFile {
  const result: ParsedFile = {
    functions: [],
    classes: [],
    imports: [],
    exports: [],
    types: []
  };

  try {
    // Parse the code into an AST with appropriate plugins
    // Use 'unambiguous' to auto-detect module vs script based on import/export presence
    const ast = parser.parse(code, {
      sourceType: 'unambiguous',
      plugins: getParserPlugins(filename)
    });

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
                           isExportedNode(path.parentPath.parentPath);
          
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

  return result;
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
 * @deprecated Use parseSourceFile instead. This alias is kept for backward compatibility.
 */
export const parseTypeScriptFile = parseSourceFile;
