import type { ParserPlugin } from "@babel/parser";
import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { ParsedFile, TemplateSelector } from "../types";
import { getParamName, isExportedNode } from "../utils";
import { finalizeTemplateSelectors, SELECTOR_ATTRIBUTES } from "./markup-selectors";

/**
 * Determine if file is TypeScript based on extension.
 */
function isTypeScriptFile(filename: string): boolean {
    const ext = filename.split(".").pop()?.toLowerCase() || "";
    return ["ts", "tsx", "mts", "cts"].includes(ext);
}

/**
 * Get appropriate Babel parser plugins based on file type.
 */
function getParserPlugins(filename: string): ParserPlugin[] {
    const plugins: ParserPlugin[] = [
        ["decorators", { decoratorsBeforeExport: true }], // Modern decorator syntax
        "classProperties",
        "classPrivateProperties",
        "classPrivateMethods",
        "classStaticBlock",
        "privateIn",
        "dynamicImport",
        "exportDefaultFrom",
        "exportNamespaceFrom",
        "importMeta",
        "topLevelAwait",
        "optionalChaining",
        "nullishCoalescingOperator",
        "logicalAssignment",
        "numericSeparator",
        "bigInt",
        ["importAttributes", { deprecatedAssertSyntax: true }],
    ];

    // Add TypeScript plugin for TS files
    if (isTypeScriptFile(filename)) {
        plugins.push("typescript");
    }

    // Always add JSX support - many JS files use JSX without the explicit extension
    plugins.push("jsx");

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
export function parseSourceFile(
    code: string,
    filename = "unknown.js",
): import("../types").ParsedFileWithAst {
    const result: ParsedFile = {
        functions: [],
        classes: [],
        imports: [],
        exports: [],
        types: [],
    };

    let astTree: unknown;
    const jsxSelectors: TemplateSelector[] = [];
    const jsxRoutes: string[] = [];

    try {
        // Parse the code into an AST with appropriate plugins
        // Use 'unambiguous' to auto-detect module vs script based on import/export presence
        const ast = parser.parse(code, {
            sourceType: "unambiguous",
            plugins: getParserPlugins(filename),
        });

        // Store complete AST for advanced features (test generation, refactoring, etc.)
        astTree = ast;

        // Traverse the AST
        traverse(ast, {
            // Selectors written as JSX attributes (data-testid, aria-label,
            // placeholder, role). These are the React/Svelte-in-JSX equivalent of
            // the markup template selectors, and they feed the same grounding
            // evidence: a test id in a component is real even when no crawl
            // reached the state that renders it (dialogs, validation, filled
            // carts). Literal values only — a computed attribute is a guess.
            JSXAttribute(path) {
                const node = path.node;
                if (!t.isJSXIdentifier(node.name)) return;

                const rawName = node.name.name;
                const kind = SELECTOR_ATTRIBUTES[rawName.toLowerCase()];
                if (!kind) return;

                let value: string | null = null;
                if (t.isStringLiteral(node.value)) {
                    value = node.value.value;
                } else if (t.isJSXExpressionContainer(node.value)) {
                    const expression = node.value.expression;
                    if (t.isStringLiteral(expression)) value = expression.value;
                }
                if (value === null) return;
                value = value.trim();
                if (!value || value.length > 120) return;

                const selector: TemplateSelector = {
                    kind,
                    value,
                    line: node.loc?.start.line ?? 0,
                };
                if (kind === "testId") selector.attribute = rawName.toLowerCase();
                jsxSelectors.push(selector);
            },

            // React Router <Route path="..."> — the client-side route table.
            // cover needs these so a draft navigates to a real route instead of
            // guessing (e.g. /product/:slug, not /products/<made-up-slug>).
            JSXOpeningElement(path) {
                const node = path.node;
                if (!t.isJSXIdentifier(node.name) || node.name.name !== "Route") return;
                for (const attr of node.attributes) {
                    if (!t.isJSXAttribute(attr) || !t.isJSXIdentifier(attr.name)) continue;
                    if (attr.name.name !== "path") continue;
                    let value: string | null = null;
                    if (t.isStringLiteral(attr.value)) {
                        value = attr.value.value;
                    } else if (
                        t.isJSXExpressionContainer(attr.value) &&
                        t.isStringLiteral(attr.value.expression)
                    ) {
                        value = attr.value.expression.value;
                    }
                    if (value?.trim()) jsxRoutes.push(value.trim());
                }
            },

            // Function declarations: function foo() {}
            FunctionDeclaration(path) {
                const node = path.node;
                if (t.isIdentifier(node.id)) {
                    result.functions.push({
                        name: node.id.name,
                        params: node.params.map((p) => getParamName(p)),
                        isAsync: node.async,
                        isExported: isExportedNode(path),
                        line: node.loc?.start.line || 0,
                    });
                }
            },

            // Arrow functions and function expressions: const foo = () => {}
            VariableDeclarator(path) {
                const node = path.node;
                if (
                    t.isIdentifier(node.id) &&
                    (t.isArrowFunctionExpression(node.init) || t.isFunctionExpression(node.init))
                ) {
                    // Check both parent and grandparent for export
                    // VariableDeclarator → VariableDeclaration → ExportNamedDeclaration
                    const isExported =
                        isExportedNode(path.parentPath) ||
                        (path.parentPath?.parentPath
                            ? isExportedNode(path.parentPath.parentPath)
                            : false);

                    result.functions.push({
                        name: node.id.name,
                        params: node.init.params.map((p) => getParamName(p)),
                        isAsync: node.init.async,
                        isExported,
                        line: node.loc?.start.line || 0,
                    });
                }
            },

            // Class declarations: class Foo {}
            ClassDeclaration(path) {
                const node = path.node;
                if (t.isIdentifier(node.id)) {
                    const methods: string[] = [];
                    const properties: string[] = [];

                    node.body.body.forEach((member) => {
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
                        line: node.loc?.start.line || 0,
                    });
                }
            },

            // Import declarations: import { foo } from 'bar'
            ImportDeclaration(path) {
                const node = path.node;

                // Separate import types
                const defaultSpec = node.specifiers.find((s) => t.isImportDefaultSpecifier(s));
                const namespaceSpec = node.specifiers.find((s) => t.isImportNamespaceSpecifier(s));
                const namedSpecs = node.specifiers.filter((s) => t.isImportSpecifier(s));

                result.imports.push({
                    source: node.source.value,
                    defaultImport: defaultSpec
                        ? (defaultSpec as t.ImportDefaultSpecifier).local.name
                        : undefined,
                    namespaceImport: namespaceSpec
                        ? (namespaceSpec as t.ImportNamespaceSpecifier).local.name
                        : undefined,
                    namedImports: namedSpecs.map((s) => (s as t.ImportSpecifier).local.name),
                    // Declaration-level `import type` OR every specifier
                    // inline-marked `import { type Foo }` (TS 4.5+).
                    isTypeOnly:
                        node.importKind === "type" ||
                        (namedSpecs.length > 0 &&
                            namedSpecs.every(
                                (s) => (s as t.ImportSpecifier).importKind === "type",
                            )),
                });
            },

            // Named export declarations: export { foo } or export function foo() {}
            ExportNamedDeclaration(path) {
                const node = path.node;

                // Handle re-exports: export { foo, bar } from './module'
                // or local exports: export { foo, bar }
                if (node.specifiers && node.specifiers.length > 0) {
                    // A re-export IS a dependency edge: record the source so
                    // code-graph resolves imports for barrel files (review
                    // finding: the source was discarded, leaving `export *`
                    // and `export { x } from` files with empty edge sets).
                    if (node.source) {
                        result.imports.push({
                            source: node.source.value,
                            namedImports: node.specifiers
                                .filter((spec) => t.isExportSpecifier(spec))
                                .map(
                                    (spec) =>
                                        (t.isIdentifier(spec.local)
                                            ? spec.local.name
                                            : String(spec.local.value)),
                                ),
                            isTypeOnly: node.exportKind === "type",
                        });
                    }
                    node.specifiers.forEach((spec) => {
                        if (t.isExportSpecifier(spec)) {
                            const exportedName = t.isIdentifier(spec.exported)
                                ? spec.exported.name
                                : t.isStringLiteral(spec.exported)
                                  ? spec.exported.value
                                  : "<unknown>";
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
                    decl.declarations.forEach((d) => {
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
                let exportName = "default";

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

            // Export-all re-exports: export * from './module' — the standard
            // barrel-file pattern. Without this visitor the dependency edge
            // was never recorded at all (review finding).
            ExportAllDeclaration(path) {
                const node = path.node;
                if (node.source) {
                    result.imports.push({
                        source: node.source.value,
                        namedImports: [],
                        isTypeOnly: node.exportKind === "type",
                    });
                }
            },

            // Dynamic imports (import('./m')) and CJS requires — the other
            // dependency edges a plain ImportDeclaration-only pass misses.
            CallExpression(path) {
                const node = path.node;
                const arg = node.arguments[0];
                if (!arg || !t.isStringLiteral(arg)) return;
                if (node.callee.type === "Import") {
                    result.imports.push({
                        source: arg.value,
                        namedImports: [],
                    });
                } else if (
                    t.isIdentifier(node.callee) &&
                    node.callee.name === "require" &&
                    !path.scope.hasBinding("require")
                ) {
                    result.imports.push({
                        source: arg.value,
                        namedImports: [],
                    });
                }
            },

            // TypeScript type alias: type Foo = ...
            TSTypeAliasDeclaration(path) {
                const node = path.node;
                if (t.isIdentifier(node.id)) {
                    result.types.push({
                        name: node.id.name,
                        kind: "type",
                        isExported: isExportedNode(path),
                        line: node.loc?.start.line || 0,
                    });
                }
            },

            // TypeScript interface: interface Foo {}
            TSInterfaceDeclaration(path) {
                const node = path.node;
                if (t.isIdentifier(node.id)) {
                    result.types.push({
                        name: node.id.name,
                        kind: "interface",
                        isExported: isExportedNode(path),
                        line: node.loc?.start.line || 0,
                    });
                }
            },

            // TypeScript enum: enum Foo {}
            TSEnumDeclaration(path) {
                const node = path.node;
                if (t.isIdentifier(node.id)) {
                    result.types.push({
                        name: node.id.name,
                        kind: "enum",
                        isExported: isExportedNode(path),
                        line: node.loc?.start.line || 0,
                    });
                }
            },
        });
    } catch (error) {
        // Provide detailed error information
        const err = error as Error & { loc?: { line: number } };
        const line = err.loc?.line || 0;
        const message = err.message;
        const sanitizedFilename = filename.replace(/\n/g, "\\n"); // Sanitize for logging

        throw new Error(`Parse error in ${sanitizedFilename}${line ? `:${line}` : ""}: ${message}`);
    }

    if (jsxSelectors.length > 0) {
        result.templateSelectors = finalizeTemplateSelectors(jsxSelectors);
    }

    if (jsxRoutes.length > 0) {
        result.routes = [...new Set(jsxRoutes)];
    }

    // Always return both parsed structure (for embeddings) and complete AST (for test generation)
    return { parsed: result, ast: astTree };
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
export function fullAstToSearchableText(
    ast: unknown,
    filePath: string,
    sourceCode?: string,
): string {
    const lines = [`File: ${filePath}\n`];
    const astNode = ast as t.File;

    if (!astNode || !astNode.program) {
        return lines.join("\n");
    }

    // Traverse AST and extract detailed information
    traverse(astNode, {
        // Function declarations with full context
        FunctionDeclaration(path) {
            const node = path.node;
            if (t.isIdentifier(node.id)) {
                const async = node.async ? "async " : "";
                const exported = isExportedNode(path) ? "export " : "";
                const params = node.params.map((p) => getParamName(p)).join(", ");

                lines.push(`${exported}${async}function ${node.id.name}(${params})`);

                // Add function body context (first few statements)
                if (node.body && node.body.body.length > 0) {
                    const bodyPreview = node.body.body
                        .slice(0, 3)
                        .map((stmt) => {
                            return `  ${t.isReturnStatement(stmt) ? "returns" : t.isIfStatement(stmt) ? "if condition" : "statement"}`;
                        })
                        .join("\n");
                    lines.push(bodyPreview);
                }
                lines.push("");
            }
        },

        // Arrow functions and function expressions
        VariableDeclarator(path) {
            const node = path.node;
            if (
                t.isIdentifier(node.id) &&
                (t.isArrowFunctionExpression(node.init) || t.isFunctionExpression(node.init))
            ) {
                const async = node.init.async ? "async " : "";
                const params = node.init.params.map((p) => getParamName(p)).join(", ");
                const exported =
                    isExportedNode(path.parentPath) ||
                    (path.parentPath?.parentPath
                        ? isExportedNode(path.parentPath.parentPath)
                        : false)
                        ? "export "
                        : "";

                lines.push(`${exported}${async}const ${node.id.name} = (${params}) => {...}`);
                lines.push("");
            }
        },

        // Classes with full details
        ClassDeclaration(path) {
            const node = path.node;
            if (t.isIdentifier(node.id)) {
                const exported = isExportedNode(path) ? "export " : "";
                lines.push(`${exported}class ${node.id.name}`);

                // List all methods and properties
                node.body.body.forEach((member) => {
                    if (t.isClassMethod(member)) {
                        const key = member.key;
                        let name = "unknown";
                        if (t.isIdentifier(key)) {
                            name = key.name;
                        } else if (t.isPrivateName(key)) {
                            name = `#${(key as t.PrivateName).id.name}`;
                        }
                        const kind =
                            member.kind === "constructor"
                                ? "constructor"
                                : member.kind === "get"
                                  ? "getter"
                                  : member.kind === "set"
                                    ? "setter"
                                    : "method";
                        const async = member.async ? "async " : "";
                        const params = member.params.map((p) => getParamName(p)).join(", ");
                        lines.push(`  ${async}${kind} ${name}(${params})`);
                    } else if (t.isClassProperty(member)) {
                        const key = member.key;
                        let name = "unknown";
                        if (t.isIdentifier(key)) {
                            name = key.name;
                        } else if (t.isPrivateName(key)) {
                            name = `#${(key as t.PrivateName).id.name}`;
                        }
                        lines.push(`  property ${name}`);
                    }
                });
                lines.push("");
            }
        },

        // Type definitions
        TSInterfaceDeclaration(path) {
            const node = path.node;
            if (t.isIdentifier(node.id)) {
                const exported = isExportedNode(path) ? "export " : "";
                lines.push(`${exported}interface ${node.id.name}`);

                // List interface members
                if (node.body?.body) {
                    node.body.body.slice(0, 5).forEach((member) => {
                        if (t.isTSPropertySignature(member) && t.isIdentifier(member.key)) {
                            lines.push(
                                `  ${member.key.name}: ${member.typeAnnotation ? "type" : "any"}`,
                            );
                        } else if (t.isTSMethodSignature(member) && t.isIdentifier(member.key)) {
                            const params =
                                member.parameters
                                    ?.map((p) => (t.isIdentifier(p) ? p.name : "param"))
                                    .join(", ") || "";
                            lines.push(`  ${member.key.name}(${params})`);
                        }
                    });
                }
                lines.push("");
            }
        },

        TSTypeAliasDeclaration(path) {
            const node = path.node;
            if (t.isIdentifier(node.id)) {
                const exported = isExportedNode(path) ? "export " : "";
                lines.push(`${exported}type ${node.id.name} = ...`);
                lines.push("");
            }
        },

        TSEnumDeclaration(path) {
            const node = path.node;
            if (t.isIdentifier(node.id)) {
                const exported = isExportedNode(path) ? "export " : "";
                lines.push(`${exported}enum ${node.id.name}`);

                // List enum members
                node.members.slice(0, 5).forEach((member) => {
                    if (t.isIdentifier(member.id)) {
                        lines.push(`  ${member.id.name}`);
                    }
                });
                lines.push("");
            }
        },

        // Import statements with full details
        ImportDeclaration(path) {
            const node = path.node;
            const source = node.source.value;
            const specifiers: string[] = [];

            node.specifiers.forEach((spec) => {
                if (t.isImportDefaultSpecifier(spec)) {
                    specifiers.push(spec.local.name);
                } else if (t.isImportNamespaceSpecifier(spec)) {
                    specifiers.push(`* as ${spec.local.name}`);
                } else if (t.isImportSpecifier(spec)) {
                    specifiers.push(spec.local.name);
                }
            });

            if (specifiers.length > 0) {
                lines.push(`import ${specifiers.join(", ")} from "${source}"`);
            }
        },
    });

    // If source code is provided, add snippets of key sections
    if (sourceCode) {
        const codeLines = sourceCode.split("\n");
        if (codeLines.length > 0 && codeLines.length < 50) {
            lines.push("\n--- Code Snippet ---");
            lines.push(sourceCode.substring(0, 500)); // First 500 chars
        }
    }

    return lines.join("\n");
}
