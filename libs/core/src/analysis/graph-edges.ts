import type { CodeNode, GraphEdge } from "../types";

/**
 * The edges persisted for one file: file-level imports plus the symbol-level
 * edges (calls, extends, implements, renders) the code graph resolved for it.
 * Symbols and their edges come from graft (see `graft.ts`); this only shapes
 * them for the `graph_edges` table.
 */
export function buildEdgesForNode(node: CodeNode): GraphEdge[] {
    const edges: GraphEdge[] = node.imports.map((target) => ({
        kind: "imports" as const,
        sourceFile: node.filePath,
        targetFile: target,
        provenance: "static_ast" as const,
        confidence: 1.0,
    }));
    edges.push(...(node.edges ?? []));
    return edges;
}
