import traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { CodeNode, GraphEdge, ParsedSymbol } from "../types";
import { getParamName, isExportedNode } from "../utils";

/**
 * Extract first-class symbols from a Babel AST: functions, arrow functions,
 * classes (with their methods), interfaces, type aliases, enums, plus a
 * best-effort identification of route handlers (Next/Express style) and
 * React components.
 *
 * For every function-like symbol we also collect:
 *  - `callees`: identifier names of functions called inside its body
 *  - `rendered`: JSX component identifiers used inside its body
 *
 * These two arrays are what powers the symbol-level "calls" / "renders"
 * edges later on.
 */
export function extractSymbolsFromAst(
    ast: unknown,
    filePath: string,
): { symbols: ParsedSymbol[]; intraFileEdges: GraphEdge[] } {
    const symbols: ParsedSymbol[] = [];
    const intraFileEdges: GraphEdge[] = [];

    const astNode = ast as t.File | undefined;
    if (!astNode || !astNode.program) {
        return { symbols, intraFileEdges };
    }

    const isComponentName = (name: string): boolean => /^[A-Z][A-Za-z0-9_]*$/.test(name);

    const looksLikeRouteFile = isRouteLikeFile(filePath);

    traverse(astNode, {
        FunctionDeclaration(p) {
            const node = p.node;
            if (!t.isIdentifier(node.id)) return;
            const name = node.id.name;
            const range = bodyRange(node);
            const { callees, rendered } = collectBodyReferences(node.body);

            const sym: ParsedSymbol = {
                name,
                kind: isComponentName(name) ? "component" : "function",
                startLine: node.loc?.start.line ?? 0,
                endLine: range.end,
                isExported: isExportedNode(p),
                isAsync: !!node.async,
                signature: signatureFor(name, node.params, node.async),
                callees,
                rendered,
            };

            if (looksLikeRouteFile) {
                const route = inferRouteMeta(filePath, name);
                if (route) sym.routeMeta = route;
            }

            symbols.push(sym);
        },

        VariableDeclarator(p) {
            const node = p.node;
            if (!t.isIdentifier(node.id)) return;
            if (!node.init) return;
            if (!t.isArrowFunctionExpression(node.init) && !t.isFunctionExpression(node.init))
                return;

            const fn = node.init;
            const name = node.id.name;
            const range = bodyRange(node);
            const body = fn.body;
            const { callees, rendered } = t.isBlockStatement(body)
                ? collectBodyReferences(body)
                : collectExpressionReferences(body);

            const isExported =
                isExportedNode(p.parentPath) ||
                (p.parentPath?.parentPath ? isExportedNode(p.parentPath.parentPath) : false);

            const sym: ParsedSymbol = {
                name,
                kind: isComponentName(name) ? "component" : "arrow_function",
                startLine: node.loc?.start.line ?? 0,
                endLine: range.end,
                isExported,
                isAsync: !!fn.async,
                signature: signatureFor(name, fn.params, fn.async),
                callees,
                rendered,
            };

            if (looksLikeRouteFile) {
                const route = inferRouteMeta(filePath, name);
                if (route) sym.routeMeta = route;
            }

            symbols.push(sym);
        },

        ClassDeclaration(p) {
            const node = p.node;
            if (!t.isIdentifier(node.id)) return;
            const className = node.id.name;
            const range = bodyRange(node);

            symbols.push({
                name: className,
                kind: "class",
                startLine: node.loc?.start.line ?? 0,
                endLine: range.end,
                isExported: isExportedNode(p),
                signature: `class ${className}`,
            });

            // Edges from class -> superclass / interfaces (intra-file resolution)
            if (node.superClass && t.isIdentifier(node.superClass)) {
                intraFileEdges.push({
                    kind: "extends",
                    sourceFile: filePath,
                    targetFile: filePath,
                    sourceSymbol: className,
                    targetSymbol: node.superClass.name,
                    provenance: "static_ast",
                    confidence: 0.95,
                    evidence: {
                        line: node.loc?.start.line,
                        snippet: `extends ${node.superClass.name}`,
                    },
                });
            }
            if (node.implements) {
                for (const impl of node.implements) {
                    if (t.isClassImplements(impl) && t.isIdentifier(impl.id)) {
                        intraFileEdges.push({
                            kind: "implements",
                            sourceFile: filePath,
                            targetFile: filePath,
                            sourceSymbol: className,
                            targetSymbol: impl.id.name,
                            provenance: "static_ast",
                            confidence: 0.95,
                        });
                    }
                }
            }

            for (const member of node.body.body) {
                if (t.isClassMethod(member)) {
                    const key = member.key;
                    let methodName = "<unknown>";
                    if (t.isIdentifier(key)) methodName = key.name;
                    else if (t.isPrivateName(key)) {
                        const priv = key as t.PrivateName;
                        methodName = `#${priv.id.name}`;
                    } else if (t.isStringLiteral(key)) methodName = key.value;

                    const methodRange = bodyRange(member);
                    const { callees, rendered } = collectBodyReferences(member.body);

                    symbols.push({
                        name: methodName,
                        kind: "method",
                        startLine: member.loc?.start.line ?? range.start,
                        endLine: methodRange.end,
                        isExported: isExportedNode(p),
                        isAsync: !!member.async,
                        parent: className,
                        signature: `${className}.${methodName}(${member.params.map((pa) => getParamName(pa)).join(", ")})`,
                        callees,
                        rendered,
                    });
                }
            }
        },

        TSInterfaceDeclaration(p) {
            const node = p.node;
            if (!t.isIdentifier(node.id)) return;
            const range = bodyRange(node);
            symbols.push({
                name: node.id.name,
                kind: "interface",
                startLine: node.loc?.start.line ?? 0,
                endLine: range.end,
                isExported: isExportedNode(p),
                signature: `interface ${node.id.name}`,
            });
        },

        TSTypeAliasDeclaration(p) {
            const node = p.node;
            if (!t.isIdentifier(node.id)) return;
            const range = bodyRange(node);
            symbols.push({
                name: node.id.name,
                kind: "type",
                startLine: node.loc?.start.line ?? 0,
                endLine: range.end,
                isExported: isExportedNode(p),
                signature: `type ${node.id.name}`,
            });
        },

        TSEnumDeclaration(p) {
            const node = p.node;
            if (!t.isIdentifier(node.id)) return;
            const range = bodyRange(node);
            symbols.push({
                name: node.id.name,
                kind: "enum",
                startLine: node.loc?.start.line ?? 0,
                endLine: range.end,
                isExported: isExportedNode(p),
                signature: `enum ${node.id.name}`,
            });
        },
    });

    // Express-style route detection: app.get('/x', handler) / router.post(...)
    if (looksLikeRouteFile || isExpressLikeFile(astNode)) {
        traverse(astNode, {
            CallExpression(p) {
                const route = expressRouteFromCall(p);
                if (!route) return;
                const handlerName = route.handlerName ?? `${route.method}_${route.path}`;
                symbols.push({
                    name: handlerName,
                    kind: "route",
                    startLine: p.node.loc?.start.line ?? 0,
                    endLine: p.node.loc?.end.line ?? p.node.loc?.start.line ?? 0,
                    isExported: false,
                    signature: `${route.method} ${route.path}`,
                    routeMeta: { method: route.method, path: route.path, kind: "handler" },
                });
            },
        });
    }

    // Heuristic: pages in Next.js have routeMeta even when the export name doesn't reveal it.
    if (looksLikeRouteFile) {
        const pageRoute = inferNextRouteFromPath(filePath);
        if (pageRoute) {
            const pageName = pageRoute.kind === "page" ? "Page" : "Handler";
            const exists = symbols.find((s) => s.routeMeta && s.routeMeta.path === pageRoute.path);
            if (!exists) {
                symbols.push({
                    name: pageName,
                    kind: "route",
                    startLine: 1,
                    endLine: 1,
                    isExported: true,
                    signature: pageRoute.path,
                    routeMeta: pageRoute,
                });
            }
        }
    }

    return { symbols, intraFileEdges };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bodyRange(node: t.Node): { start: number; end: number } {
    return {
        start: node.loc?.start.line ?? 0,
        end: node.loc?.end.line ?? node.loc?.start.line ?? 0,
    };
}

function signatureFor(name: string, params: t.Node[], isAsync: boolean): string {
    const async = isAsync ? "async " : "";
    return `${async}${name}(${params.map((p) => getParamName(p)).join(", ")})`;
}

function collectBodyReferences(body: t.Node | null | undefined): {
    callees: string[];
    rendered: string[];
} {
    const callees = new Set<string>();
    const rendered = new Set<string>();

    if (!body) return { callees: [], rendered: [] };

    // Walk the sub-tree manually without invoking babel's scope analysis.
    // Babel's traverse() requires a Program-level scope; using a manual
    // walker keeps this safe and dependency-free.
    walk(body, (node) => {
        if (t.isCallExpression(node)) {
            const name = calleeName(node.callee);
            if (name) callees.add(name);
            return;
        }
        if (t.isJSXOpeningElement(node)) {
            const tag = node.name;
            if (t.isJSXIdentifier(tag)) {
                const n = tag.name;
                if (/^[A-Z]/.test(n)) rendered.add(n);
            } else if (t.isJSXMemberExpression(tag)) {
                const root = jsxMemberRoot(tag);
                if (root && /^[A-Z]/.test(root)) rendered.add(root);
            }
        }
    });

    return { callees: Array.from(callees), rendered: Array.from(rendered) };
}

function collectExpressionReferences(body: t.Expression): {
    callees: string[];
    rendered: string[];
} {
    return collectBodyReferences(body);
}

/**
 * Lightweight depth-first walker over a Babel AST sub-tree.
 * Avoids babel/traverse's program-level scope requirement.
 */
function walk(node: t.Node, visit: (n: t.Node) => void): void {
    visit(node);
    const keys = (t.VISITOR_KEYS as Record<string, string[] | undefined>)[node.type];
    if (!keys) return;
    for (const key of keys) {
        const child = (node as unknown as Record<string, unknown>)[key];
        if (!child) continue;
        if (Array.isArray(child)) {
            for (const c of child) {
                if (c && typeof c === "object" && "type" in c) {
                    walk(c as t.Node, visit);
                }
            }
        } else if (typeof child === "object" && "type" in child) {
            walk(child as t.Node, visit);
        }
    }
}

function calleeName(node: t.Node): string | null {
    if (t.isIdentifier(node)) return node.name;
    if (t.isMemberExpression(node) && t.isIdentifier(node.property)) return node.property.name;
    return null;
}

function jsxMemberRoot(node: t.JSXMemberExpression): string | null {
    let cur: t.JSXMemberExpression | t.JSXIdentifier = node;
    while (t.isJSXMemberExpression(cur)) {
        cur = cur.object;
    }
    return t.isJSXIdentifier(cur) ? cur.name : null;
}

// ---------------------------------------------------------------------------
// Route detection
// ---------------------------------------------------------------------------

function isRouteLikeFile(filePath: string): boolean {
    const norm = filePath.replace(/\\/g, "/");
    return (
        /\/(pages|app)\//.test(norm) ||
        /\/api\//.test(norm) ||
        /\/routes?\//.test(norm) ||
        /\/handlers?\//.test(norm)
    );
}

function isExpressLikeFile(ast: t.File): boolean {
    let express = false;
    traverse(ast, {
        ImportDeclaration(p) {
            const src = p.node.source.value;
            if (src === "express" || src === "fastify" || src === "koa" || src === "hono") {
                express = true;
                p.stop();
            }
        },
    });
    return express;
}

function expressRouteFromCall(
    p: NodePath<t.CallExpression>,
): { method: string; path: string; handlerName?: string } | null {
    const callee = p.node.callee;
    if (!t.isMemberExpression(callee)) return null;
    if (!t.isIdentifier(callee.property)) return null;
    const method = callee.property.name.toUpperCase();
    if (
        !["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "ALL", "USE"].includes(method)
    ) {
        return null;
    }

    const args = p.node.arguments;
    if (args.length === 0) return null;
    const first = args[0];
    if (!t.isStringLiteral(first)) return null;
    const routePath = first.value;

    let handlerName: string | undefined;
    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (t.isIdentifier(arg)) {
            handlerName = arg.name;
            break;
        }
    }

    return { method, path: routePath, handlerName };
}

function inferRouteMeta(
    filePath: string,
    exportName: string,
): ParsedSymbol["routeMeta"] | undefined {
    const norm = filePath.replace(/\\/g, "/");
    const lower = exportName.toLowerCase();

    if (
        /\/api\//.test(norm) &&
        ["get", "post", "put", "delete", "patch", "options", "head", "handler", "default"].includes(
            lower,
        )
    ) {
        return {
            method: lower === "default" || lower === "handler" ? undefined : lower.toUpperCase(),
            path: nextRoutePathFromFile(norm),
            kind: "api",
        };
    }

    if (/\/(pages|app)\//.test(norm) && ["default", "page"].includes(lower)) {
        return {
            path: nextRoutePathFromFile(norm),
            kind: "page",
        };
    }

    return undefined;
}

function inferNextRouteFromPath(filePath: string): ParsedSymbol["routeMeta"] | undefined {
    const norm = filePath.replace(/\\/g, "/");
    if (/\/api\//.test(norm)) {
        return { path: nextRoutePathFromFile(norm), kind: "api" };
    }
    if (/\/(pages|app)\//.test(norm)) {
        return { path: nextRoutePathFromFile(norm), kind: "page" };
    }
    return undefined;
}

function nextRoutePathFromFile(norm: string): string {
    // Strip everything before pages/ or app/ and the extension; collapse index/route segments.
    const m = norm.match(/\/(?:pages|app)\/(.+)$/);
    if (!m) return norm;
    let route = "/" + m[1].replace(/\.[^/.]+$/, "");
    route = route.replace(/\/(index|page|route)$/i, "");
    if (!route) route = "/";
    return route;
}

// ---------------------------------------------------------------------------
// Edge construction (file + symbol level)
// ---------------------------------------------------------------------------

/**
 * Build the complete edge set for a single file given its parsed CodeNode and
 * the intra-file edges produced by `extractSymbolsFromAst`.
 *
 * Produces:
 *   - imports edges  (file → file, provenance: static_ast)
 *   - extends/implements edges (already collected by extractor)
 *   - calls edges (symbol → symbol or file, provenance: static_ast)
 *   - renders edges (symbol → file, provenance: static_ast)
 *
 * Confidence drops when we can only resolve to a file (not the exact target
 * symbol) or when we couldn't prove the binding came from a project import.
 */
export function buildEdgesForNode(node: CodeNode, intraFileEdges: GraphEdge[]): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const filePath = node.filePath;

    // --- 1. import edges (file → file)
    for (const target of node.imports) {
        edges.push({
            kind: "imports",
            sourceFile: filePath,
            targetFile: target,
            provenance: "static_ast",
            confidence: 1.0,
        });
    }

    // --- 2. intra-file class relationships
    edges.push(...intraFileEdges);

    // Map each imported binding name -> its declared source string.
    const bindingToSource = new Map<string, string>();
    for (const imp of node.parsed.imports) {
        if (imp.defaultImport) bindingToSource.set(imp.defaultImport, imp.source);
        if (imp.namespaceImport) bindingToSource.set(imp.namespaceImport, imp.source);
        for (const named of imp.namedImports) bindingToSource.set(named, imp.source);
    }

    const resolveBinding = (binding: string): string | undefined => {
        const source = bindingToSource.get(binding);
        if (!source) return undefined;
        return resolveImportSourceToFile(source, node.imports);
    };

    const localSymbolNames = new Set((node.symbols ?? []).map((s) => s.name));

    // --- 3. calls + renders edges per symbol
    for (const sym of node.symbols ?? []) {
        const symEvidenceLine = sym.startLine;

        for (const callee of sym.callees ?? []) {
            // Local resolution first (cheapest, highest confidence)
            if (localSymbolNames.has(callee) && callee !== sym.name) {
                edges.push({
                    kind: "calls",
                    sourceFile: filePath,
                    targetFile: filePath,
                    sourceSymbol: sym.name,
                    targetSymbol: callee,
                    provenance: "static_ast",
                    confidence: 0.9,
                    evidence: { line: symEvidenceLine, snippet: `${callee}(...)` },
                });
                continue;
            }

            const targetFile = resolveBinding(callee);
            if (targetFile) {
                edges.push({
                    kind: "calls",
                    sourceFile: filePath,
                    targetFile,
                    sourceSymbol: sym.name,
                    targetSymbol: callee,
                    provenance: "static_ast",
                    confidence: 0.7,
                    evidence: { line: symEvidenceLine, snippet: `${callee}(...)` },
                });
            }
        }

        for (const component of sym.rendered ?? []) {
            if (localSymbolNames.has(component) && component !== sym.name) {
                edges.push({
                    kind: "renders",
                    sourceFile: filePath,
                    targetFile: filePath,
                    sourceSymbol: sym.name,
                    targetSymbol: component,
                    provenance: "static_ast",
                    confidence: 0.85,
                    evidence: { line: symEvidenceLine, snippet: `<${component} />` },
                });
                continue;
            }

            const targetFile = resolveBinding(component);
            if (targetFile) {
                edges.push({
                    kind: "renders",
                    sourceFile: filePath,
                    targetFile,
                    sourceSymbol: sym.name,
                    targetSymbol: component,
                    provenance: "static_ast",
                    confidence: 0.7,
                    evidence: { line: symEvidenceLine, snippet: `<${component} />` },
                });
            }
        }
    }

    return edges;
}

/**
 * Map an import.source string to one of the resolved absolute paths captured
 * for a file. Tries (a) suffix match for relative imports, (b) substring
 * match, (c) no match.
 */
function resolveImportSourceToFile(source: string, resolvedImports: string[]): string | undefined {
    if (resolvedImports.length === 0) return undefined;

    // Strip any leading ./ or ../ chain — keep the meaningful tail.
    const cleaned = source.replace(/^(\.\.?\/)+/, "");
    const expectedTail = cleaned.replace(/\\/g, "/");

    // 1. Exact tail match (with or without extension)
    for (const resolved of resolvedImports) {
        const norm = resolved.replace(/\\/g, "/");
        const noExt = norm.replace(/\.[^./]+$/, "");
        if (
            norm.endsWith(`/${expectedTail}`) ||
            noExt.endsWith(`/${expectedTail}`) ||
            norm.endsWith(`/${expectedTail}/index`) ||
            noExt.endsWith(`/${expectedTail}/index`)
        ) {
            return resolved;
        }
    }

    // 2. Substring fallback (lower confidence, but still helpful for aliases)
    for (const resolved of resolvedImports) {
        if (resolved.includes(expectedTail)) {
            return resolved;
        }
    }

    return undefined;
}
