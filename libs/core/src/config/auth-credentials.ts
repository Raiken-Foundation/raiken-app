import { loadAuthConfig } from "./load";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ResolvedAuthCredentials {
    username?: string;
    password?: string;
    usernameEnv?: string;
    passwordEnv?: string;
}

function readEnv(name: string | undefined, environment: NodeJS.ProcessEnv): string | undefined {
    if (!name || !ENV_NAME.test(name)) return undefined;
    const value = environment[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function mapAuthCredentialsToFields(
    fields: Array<{ key: string; label: string; type?: string }>,
    credentials: ResolvedAuthCredentials,
): Record<string, string> {
    const values: Record<string, string> = {};
    for (const field of fields) {
        const identity = `${field.key} ${field.label}`.toLowerCase();
        if (
            credentials.password &&
            (field.type?.toLowerCase() === "password" || /\b(pass(?:word|wd)?)\b/i.test(identity))
        ) {
            values[field.key] = credentials.password;
            continue;
        }
        if (
            credentials.username &&
            (field.type?.toLowerCase() === "email" ||
                /\b(user(?:name)?|e-?mail|login|identifier|account|member|employee|phone|mobile)\b/i.test(
                    identity,
                ))
        ) {
            values[field.key] = credentials.username;
        }
    }
    return values;
}

/**
 * Resolve configured login credentials without exposing them to logs or
 * generated source. Named environment variables take precedence over literal
 * compatibility values in raiken.config.json.
 */
export function resolveAuthCredentials(
    projectPath: string,
    environment: NodeJS.ProcessEnv = process.env,
): ResolvedAuthCredentials {
    const credentials = loadAuthConfig(projectPath).credentials;
    if (!credentials) return {};

    return {
        username: readEnv(credentials.usernameEnv, environment) ?? credentials.username,
        password: readEnv(credentials.passwordEnv, environment) ?? credentials.password,
        usernameEnv: credentials.usernameEnv,
        passwordEnv: credentials.passwordEnv,
    };
}

export function authCredentialEnvGuidance(projectPath: string): string | null {
    const credentials = loadAuthConfig(projectPath).credentials;
    const lines: string[] = [];
    if (credentials?.usernameEnv && ENV_NAME.test(credentials.usernameEnv)) {
        lines.push(`- Read the login identifier from process.env.${credentials.usernameEnv}.`);
    }
    if (credentials?.passwordEnv && ENV_NAME.test(credentials.passwordEnv)) {
        lines.push(`- Read the login secret from process.env.${credentials.passwordEnv}.`);
    }
    return lines.length > 0 ? lines.join("\n") : null;
}
