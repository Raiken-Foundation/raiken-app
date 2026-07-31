export type CommandFlagValue = boolean | string | string[];

export interface ParsedCommandArgs {
    positionals: string[];
    flags: Record<string, CommandFlagValue>;
}

// Every flag the REPL reads via `booleanFlag()` must be listed here —
// otherwise `--flag <token>` swallows the following positional as its value
// and `booleanFlag()` then reads the flag as false.
const BOOLEAN_FLAGS = new Set([
    "apply",
    "auth",
    "configOnly",
    "continue",
    "dryRun",
    "embeddings",
    "fix",
    "force",
    "headed",
    "husky",
    "json",
    "list",
    "noEmbedScreenshots",
    "noImpact",
    "noInterpret",
    "onlyFlaky",
    "open",
    "skipAuth",
    "skipRun",
    "staged",
    "status",
    "testsOnly",
    "unsetKey",
    "updateSnapshots",
    "y",
    "yes",
]);

function flagKey(raw: string): string {
    return raw
        .replace(/^-+/, "")
        .replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function addFlag(
    flags: Record<string, CommandFlagValue>,
    key: string,
    value: boolean | string,
): void {
    const current = flags[key];
    if (current === undefined) {
        flags[key] = value;
    } else if (Array.isArray(current)) {
        current.push(String(value));
    } else {
        flags[key] = [String(current), String(value)];
    }
}

/** Small shell-like tokenizer supporting quotes and backslash escapes. */
export function tokenizeCommandArgs(input: string): string[] {
    const tokens: string[] = [];
    let token = "";
    let quote: "'" | '"' | null = null;
    let escaped = false;

    const push = () => {
        if (token) tokens.push(token);
        token = "";
    };

    for (const char of input) {
        if (escaped) {
            token += char;
            escaped = false;
            continue;
        }
        if (char === "\\") {
            escaped = true;
            continue;
        }
        if (quote) {
            if (char === quote) quote = null;
            else token += char;
            continue;
        }
        // Only treat a quote as an opener at a token boundary (start of a
        // token or right after `--key=`). A mid-word apostrophe is literal —
        // `/cover user's checkout flow` must not silently eat everything
        // after the apostrophe.
        if ((char === "'" || char === '"') && (token === "" || token.endsWith("="))) {
            quote = char;
            continue;
        }
        if (/\s/.test(char)) {
            push();
            continue;
        }
        token += char;
    }
    if (escaped) token += "\\";
    push();
    return tokens;
}

/**
 * Parse a slash command's remainder into positional values and Commander-like
 * flags. Supports `--key value`, `--key=value`, booleans, short flags, quoted
 * values, and repeated flags (returned as a string array).
 */
export function parseCommandArgs(input: string): ParsedCommandArgs {
    const tokens = tokenizeCommandArgs(input);
    const positionals: string[] = [];
    const flags: Record<string, CommandFlagValue> = {};
    let positionalOnly = false;

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (positionalOnly) {
            positionals.push(token);
            continue;
        }
        if (token === "--") {
            positionalOnly = true;
            continue;
        }
        if (!token.startsWith("-") || token === "-") {
            positionals.push(token);
            continue;
        }

        const equals = token.indexOf("=");
        if (equals > 0) {
            addFlag(flags, flagKey(token.slice(0, equals)), token.slice(equals + 1));
            continue;
        }

        const key = flagKey(token);
        if (BOOLEAN_FLAGS.has(key)) {
            addFlag(flags, key, true);
            continue;
        }
        const next = tokens[index + 1];
        if (next !== undefined && !next.startsWith("-")) {
            addFlag(flags, key, next);
            index += 1;
        } else {
            addFlag(flags, key, true);
        }
    }

    return { positionals, flags };
}

export function stringFlag(parsed: ParsedCommandArgs, ...names: string[]): string | undefined {
    for (const name of names) {
        const value = parsed.flags[name];
        if (Array.isArray(value)) return value.at(-1);
        if (typeof value === "string") return value;
    }
    return undefined;
}

export function stringFlags(parsed: ParsedCommandArgs, ...names: string[]): string[] {
    for (const name of names) {
        const value = parsed.flags[name];
        if (Array.isArray(value)) return value;
        if (typeof value === "string") return [value];
    }
    return [];
}

export function booleanFlag(parsed: ParsedCommandArgs, ...names: string[]): boolean {
    return names.some((name) => parsed.flags[name] === true);
}
