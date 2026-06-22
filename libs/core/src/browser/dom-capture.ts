/**
 * Type definitions and formatting utilities for DOM capture.
 *
 * Element collection and selector construction live in BrowserSession
 * (session.ts) -- the single source of truth. This module holds only the
 * shared interfaces and the text-formatting layer consumed by the agent.
 */

export interface AccessibilityNode {
    role: string;
    name?: string;
    value?: string;
    description?: string;
    checked?: boolean | "mixed";
    pressed?: boolean | "mixed";
    selected?: boolean;
    expanded?: boolean;
    disabled?: boolean;
    level?: number;
    valuemin?: number;
    valuemax?: number;
    valuetext?: string;
    children?: AccessibilityNode[];
}

export interface DOMContext {
    url: string;
    title: string;
    accessibilityTree: AccessibilityNode | null;
    timestamp: number;
    _prerequisites?: string[];
    interactiveElements: InteractiveElement[];
    formFields: FormField[];
}

export interface InteractiveElement {
    tagName: string;
    role?: string;
    name?: string;
    text?: string;
    testId?: string;
    type?: string;
    ariaLabel?: string;
    htmlName?: string;
    htmlId?: string;
    placeholder?: string;
    suggestedSelectors: string[];
}

export interface FormField {
    name: string;
    type: string;
    label?: string;
    placeholder?: string;
    required: boolean;
    id?: string;
    suggestedSelector: string;
}

function formatAccessibilityTree(node: AccessibilityNode | null, indent = 0): string {
    if (!node) return "(empty tree)";

    const lines: string[] = [];
    const prefix = "  ".repeat(indent);

    let desc = `${prefix}• ${node.role}`;
    if (node.name) desc += `: "${node.name}"`;
    if (node.value) desc += ` [value: "${node.value}"]`;
    if (node.checked !== undefined) desc += ` [checked: ${node.checked}]`;
    if (node.selected) desc += ` [selected]`;
    if (node.disabled) desc += ` [disabled]`;
    if (node.expanded !== undefined) desc += ` [expanded: ${node.expanded}]`;

    lines.push(desc);

    if (node.children && indent < 4) {
        for (const child of node.children) {
            lines.push(formatAccessibilityTree(child, indent + 1));
        }
    } else if (node.children && node.children.length > 0) {
        lines.push(`${prefix}  ... (${node.children.length} more children)`);
    }

    return lines.join("\n");
}

export function formatDOMContext(dom: DOMContext): string {
    const lines: string[] = [
        "",
        "═══════════════════════════════════════════════════════════════",
        `[LIVE DOM CONTEXT - ${dom.url}]`,
        "═══════════════════════════════════════════════════════════════",
        `Page Title: ${dom.title}`,
        `Captured: ${new Date(dom.timestamp).toISOString()}`,
        "",
    ];

    if (dom._prerequisites && dom._prerequisites.length > 0) {
        lines.push("[PREREQUISITES]");
        lines.push("───────────────");
        lines.push("The following steps may be needed before testing:");
        for (let i = 0; i < dom._prerequisites.length; i++) {
            lines.push(`${i + 1}. ${dom._prerequisites[i]}`);
        }
        lines.push("");
    }

    lines.push("ACCESSIBILITY TREE:");
    lines.push("───────────────────");
    lines.push(formatAccessibilityTree(dom.accessibilityTree));
    lines.push("");

    if (dom.interactiveElements && dom.interactiveElements.length > 0) {
        lines.push("INTERACTIVE ELEMENTS:");
        lines.push("─────────────────────");
        for (const el of dom.interactiveElements.slice(0, 30)) {
            const typeInfo = el.type ? ` [type=${el.type}]` : "";
            lines.push(`• ${el.role}: "${el.name}"${typeInfo}`);
            lines.push(`  Selectors: ${el.suggestedSelectors.join(" | ")}`);
        }
        if (dom.interactiveElements.length > 30) {
            lines.push(`  ... and ${dom.interactiveElements.length - 30} more`);
        }
        lines.push("");
    }

    lines.push("SELECTOR PRIORITY:");
    lines.push("──────────────────");
    lines.push("1. getByRole() - Most reliable, matches accessibility tree");
    lines.push("2. getByLabel() - Great for form inputs");
    lines.push("3. getByText() - For buttons and links");
    lines.push("");
    lines.push("Use ONLY selectors from the tree above. Do NOT fabricate selectors.");
    lines.push("");

    return lines.join("\n");
}
