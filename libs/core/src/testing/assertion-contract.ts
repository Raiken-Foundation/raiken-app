import { parse } from "@babel/parser";
import traverse, { type Scope } from "@babel/traverse";
import * as t from "@babel/types";

interface Assertion {
    signature: string;
    values: string[];
    signal: string;
    expectedSignal: string;
    meaningful: boolean;
    provesPresence: boolean;
}

const STATE_MATCHERS = new Set([
    "toBeVisible",
    "toBeHidden",
    "toBeEnabled",
    "toBeDisabled",
    "toBeChecked",
    "toBeAttached",
    "toBeEmpty",
    "toBeEditable",
    "toBeFocused",
    "toBeInViewport",
    "toBeOK",
    "toBeTruthy",
    "toBeFalsy",
    "toBeDefined",
    "toBeUndefined",
    "toBeNull",
]);

/** Compare syntax without source positions, quote style, or formatting. */
function syntax(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(syntax);
    if (!node || typeof node !== "object") return node;
    return Object.fromEntries(
        Object.entries(node)
            .filter(
                ([key]) =>
                    ![
                        "start",
                        "end",
                        "loc",
                        "extra",
                        "leadingComments",
                        "trailingComments",
                        "innerComments",
                    ].includes(key),
            )
            .map(([key, value]) => [key, syntax(value)]),
    );
}

function literals(node: t.Node | null | undefined): string[] {
    if (!node) return [];
    if (t.isStringLiteral(node) || t.isNumericLiteral(node)) return [String(node.value)];
    if (t.isRegExpLiteral(node)) return [node.pattern];
    if (t.isTemplateLiteral(node) && node.expressions.length === 0)
        return [node.quasis[0]?.value.cooked ?? ""];
    const out: string[] = [];
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
        const child = (node as unknown as Record<string, unknown>)[key];
        for (const value of Array.isArray(child) ? child : [child]) {
            if (value && typeof value === "object" && "type" in value)
                out.push(...literals(value as t.Node));
        }
    }
    return out;
}

function property(node: t.MemberExpression): string | null {
    if (!node.computed && t.isIdentifier(node.property)) return node.property.name;
    return t.isStringLiteral(node.property) ? node.property.value : null;
}

function resolveExpression(node: t.Node, scope: Scope, seen = new Set<string>()): t.Node {
    if (!t.isIdentifier(node) || seen.has(node.name)) return node;
    const binding = scope.getBinding(node.name);
    if (!binding?.constant || !t.isVariableDeclarator(binding.path.node) || !binding.path.node.init)
        return node;
    return resolveExpression(
        binding.path.node.init,
        binding.path.scope,
        new Set([...seen, node.name]),
    );
}

function expectedSyntax(node: t.Node, scope: Scope, seen = new Set<t.Node>()): unknown {
    if (seen.has(node)) return syntax(node);
    const visited = new Set([...seen, node]);
    const bindings: unknown[] = [];
    t.traverseFast(node, (child) => {
        if (!t.isIdentifier(child)) return;
        const binding = scope.getBinding(child.name);
        if (
            binding &&
            t.isVariableDeclarator(binding.path.node) &&
            !visited.has(binding.path.node)
        ) {
            const next = new Set([...visited, binding.path.node]);
            bindings.push([
                child.name,
                binding.path.node.init
                    ? expectedSyntax(binding.path.node.init, binding.path.scope, next)
                    : null,
                binding.constantViolations.map((p) => expectedSyntax(p.node, p.scope, next)),
            ]);
        }
    });
    return [syntax(node), bindings];
}

function isConstant(node: t.Node): boolean {
    if (t.isLiteral(node) || t.isObjectExpression(node) || t.isArrayExpression(node)) return true;
    if (t.isUnaryExpression(node)) return isConstant(node.argument);
    if (t.isBinaryExpression(node) || t.isLogicalExpression(node))
        return isConstant(node.left) && isConstant(node.right);
    return false;
}

function matcherArguments(matcher: string, args: t.CallExpression["arguments"]): t.Node[] {
    const optionIndex = STATE_MATCHERS.has(matcher)
        ? 0
        : ["toHaveAttribute", "toHaveCSS", "toHaveJSProperty"].includes(matcher)
          ? 2
          : 1;
    return args.flatMap((arg, index) => {
        // Timing can be repaired; semantic options (checked, visible, ignoreCase)
        // remain requirements. Expected objects are never treated as options.
        if (index === optionIndex && t.isObjectExpression(arg)) {
            const properties = arg.properties.filter(
                (p) =>
                    !(
                        t.isObjectProperty(p) &&
                        !p.computed &&
                        ((t.isIdentifier(p.key) && p.key.name === "timeout") ||
                            (t.isStringLiteral(p.key) && p.key.value === "timeout"))
                    ),
            );
            return properties.length ? [t.objectExpression(properties)] : [];
        }
        return [arg];
    });
}

/** AST-derived evidence. Titles, comments and arbitrary strings are never assertions. */
export function inspectTestAssertions(code: string): {
    assertions: Assertion[];
    tests: number;
    disabled: number;
    error?: string;
} {
    const assertions: Assertion[] = [];
    let tests = 0;
    let disabled = 0;
    try {
        const ast = parse(code, {
            sourceType: "unambiguous",
            plugins: ["typescript", "jsx"],
            allowAwaitOutsideFunction: true,
        });
        const testNames = new Set(["test"]);
        const expectNames = new Set(["expect"]);
        for (const node of ast.program.body) {
            if (!t.isImportDeclaration(node)) continue;
            for (const spec of node.specifiers) {
                if (!t.isImportSpecifier(spec) || !t.isIdentifier(spec.imported)) continue;
                if (spec.imported.name === "test") testNames.add(spec.local.name);
                if (spec.imported.name === "expect") expectNames.add(spec.local.name);
            }
        }
        traverse(ast, {
            CallExpression(p) {
                const call = p.node;
                const members: string[] = [];
                let root: t.Node = call.callee;
                while (t.isMemberExpression(root)) {
                    members.unshift(property(root) ?? "<dynamic>");
                    root = root.object;
                }
                if (t.isIdentifier(root) && testNames.has(root.name)) {
                    if (members.some((m) => ["skip", "fixme", "fail", "only"].includes(m)))
                        disabled++;
                    if (
                        (!members.length ||
                            members.every((m) => ["only", "skip", "fixme"].includes(m))) &&
                        call.arguments.some(
                            (arg) =>
                                t.isFunctionExpression(arg) || t.isArrowFunctionExpression(arg),
                        )
                    )
                        tests++;
                }
                // Matcher chain: expect(actual).not.toHaveText(expected).
                if (!t.isCallExpression(root)) return;
                let expectRoot: t.Node = root.callee;
                const expectModifiers: string[] = [];
                while (t.isMemberExpression(expectRoot)) {
                    expectModifiers.unshift(property(expectRoot) ?? "<dynamic>");
                    expectRoot = expectRoot.object;
                }
                if (
                    !t.isIdentifier(expectRoot) ||
                    !expectNames.has(expectRoot.name) ||
                    members.length === 0
                )
                    return;
                const matcher = members.at(-1) ?? "<dynamic>";
                if (!matcher.startsWith("to") && matcher !== "<dynamic>") return;
                const actual = root.arguments[0];
                const resolvedActual = actual ? resolveExpression(actual, p.scope) : undefined;
                const owner = p.getFunctionParent();
                const ownerCall = owner?.parentPath;
                const ownerIsTest =
                    !owner ||
                    (!!ownerCall?.isCallExpression() &&
                        (() => {
                            let callee: t.Node = ownerCall.node.callee;
                            while (t.isMemberExpression(callee)) callee = callee.object;
                            return t.isIdentifier(callee) && testNames.has(callee.name);
                        })());
                const exits: unknown[] = [];
                owner?.traverse({
                    ReturnStatement(exit) {
                        if (exit.getFunctionParent() === owner) exits.push(syntax(exit.node));
                    },
                });
                const promiseHandling = p
                    .getAncestry()
                    .filter(
                        (ancestor) =>
                            ancestor.isCallExpression() &&
                            t.isMemberExpression(ancestor.node.callee) &&
                            ["catch", "then"].includes(property(ancestor.node.callee) ?? ""),
                    )
                    .map((ancestor) => syntax(ancestor.node));
                const mutableActual: unknown[] = [];
                if (actual)
                    t.traverseFast(actual, (child) => {
                        if (!t.isIdentifier(child)) return;
                        const binding = p.scope.getBinding(child.name);
                        if (binding && !binding.constant)
                            mutableActual.push(expectedSyntax(child, p.scope));
                    });
                const meaningful =
                    !!resolvedActual &&
                    !isConstant(resolvedActual) &&
                    ownerIsTest &&
                    exits.length === 0 &&
                    promiseHandling.length === 0;
                const expected = matcherArguments(matcher, call.arguments);
                const values = expected.flatMap((arg) => literals(resolveExpression(arg, p.scope)));
                // Moving an assertion under a catch/conditional can turn it into an optional check.
                const guards = p
                    .getAncestry()
                    .filter(
                        (ancestor) =>
                            t.isTryStatement(ancestor.node) ||
                            t.isIfStatement(ancestor.node) ||
                            t.isConditionalExpression(ancestor.node),
                    )
                    .map(({ node }) =>
                        t.isIfStatement(node) || t.isConditionalExpression(node)
                            ? [node.type, expectedSyntax(node.test, p.scope)]
                            : t.isTryStatement(node)
                              ? [node.type, syntax(node.handler)]
                              : node.type,
                    );
                const firstExpected = call.arguments[0]
                    ? resolveExpression(call.arguments[0], p.scope)
                    : null;
                const assertsAbsence =
                    members.includes("not") ||
                    ["toBeHidden", "toBeFalsy", "toBeNull", "toBeUndefined"].includes(matcher) ||
                    (matcher === "toHaveCount" &&
                        t.isNumericLiteral(firstExpected) &&
                        firstExpected.value === 0) ||
                    (t.isObjectExpression(firstExpected) &&
                        firstExpected.properties.some(
                            (option) =>
                                t.isObjectProperty(option) &&
                                t.isIdentifier(option.key) &&
                                ["visible", "attached"].includes(option.key.name) &&
                                t.isBooleanLiteral(option.value, { value: false }),
                        ));
                const presenceMatcher = STATE_MATCHERS.has(matcher) || matcher === "toHaveCount";
                assertions.push({
                    signature: JSON.stringify([
                        members,
                        expectModifiers,
                        expected.map((arg) => expectedSyntax(arg, p.scope)),
                        meaningful,
                        guards,
                        ownerCall?.isCallExpression()
                            ? [
                                  syntax(ownerCall.node.callee),
                                  t.isStringLiteral(ownerCall.node.arguments[0])
                                      ? ownerCall.node.arguments[0].value
                                      : null,
                              ]
                            : (owner?.node.type ?? "top-level"),
                        exits,
                        promiseHandling,
                        p.parentPath.isAwaitExpression(),
                        mutableActual,
                    ]),
                    values,
                    signal: [...values, ...literals(actual)].join(" "),
                    expectedSignal: [...values, ...(presenceMatcher ? literals(actual) : [])].join(
                        " ",
                    ),
                    meaningful,
                    provesPresence: meaningful && !assertsAbsence && guards.length === 0,
                });
            },
        });
        return { assertions, tests, disabled };
    } catch {
        return {
            assertions: [],
            tests: 0,
            disabled: 0,
            error: "Test assertions could not be parsed",
        };
    }
}

/** Preserve matcher, negation, expected expression and multiplicity, while allowing locator repairs. */
export function changedAssertionRequirements(before: string, after: string): string[] {
    const original = inspectTestAssertions(before);
    const candidate = inspectTestAssertions(after);
    if (original.error || candidate.error) return ["unparseable assertion contract"];
    const available = candidate.assertions.map((a) => a.signature);
    const lost: string[] = [];
    for (const assertion of original.assertions) {
        const match = available.indexOf(assertion.signature);
        if (match >= 0) available.splice(match, 1);
        else lost.push(...(assertion.values.length ? assertion.values : ["assertion semantics"]));
    }
    if (candidate.tests < original.tests || candidate.disabled > original.disabled)
        lost.push("test coverage (removed or disabled test)");
    return [...new Set(lost)].sort();
}

export function assertedScenarioTokens(
    code: string,
    options: { expectedValuesOnly?: boolean } = {},
): string[] {
    return inspectTestAssertions(code)
        .assertions.filter((a) => a.provesPresence)
        .flatMap((a) => [options.expectedValuesOnly ? a.expectedSignal : a.signal]);
}
