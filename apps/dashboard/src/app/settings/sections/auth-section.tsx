import { FieldGroup } from "../fields/field-controls";
import type { SettingsFormApi } from "../types";

type AuthSectionProps = Pick<SettingsFormApi, "val" | "valAt" | "update" | "updateAt">;

export function AuthSection({ val, valAt, update, updateAt }: AuthSectionProps) {
    return (
        <>
            <FieldGroup
                label="Storage State Path"
                hint="Path to a Playwright storageState JSON file for pre-authenticated sessions."
            >
                <input
                    type="text"
                    value={(val("auth", "storageStatePath") as string) ?? ""}
                    onChange={(e) => update("auth", "storageStatePath", e.target.value)}
                    placeholder=".raiken/auth-state.json"
                />
            </FieldGroup>
            <FieldGroup
                label="Base URL"
                hint="Base URL of the application, used to resolve the login path."
            >
                <input
                    type="text"
                    value={(val("auth", "baseUrl") as string) ?? ""}
                    onChange={(e) => update("auth", "baseUrl", e.target.value)}
                    placeholder="https://app.example.com"
                />
            </FieldGroup>
            <FieldGroup label="Login Path" hint="Path to the login page, relative to the base URL.">
                <input
                    type="text"
                    value={(val("auth", "loginPath") as string) ?? ""}
                    onChange={(e) => update("auth", "loginPath", e.target.value)}
                    placeholder="/login"
                />
            </FieldGroup>
            <FieldGroup
                label="Username Env Var"
                hint="Name of the environment variable holding the test username (never the raw value)."
            >
                <input
                    type="text"
                    value={
                        (valAt(["auth", "credentials", "usernameEnv"]) as string | undefined) ?? ""
                    }
                    onChange={(e) =>
                        updateAt(["auth", "credentials", "usernameEnv"], e.target.value)
                    }
                    placeholder="RAIKEN_TEST_USERNAME"
                />
            </FieldGroup>
            <FieldGroup
                label="Password Env Var"
                hint="Name of the environment variable holding the test password (never the raw value)."
            >
                <input
                    type="text"
                    value={
                        (valAt(["auth", "credentials", "passwordEnv"]) as string | undefined) ?? ""
                    }
                    onChange={(e) =>
                        updateAt(["auth", "credentials", "passwordEnv"], e.target.value)
                    }
                    placeholder="RAIKEN_TEST_PASSWORD"
                />
            </FieldGroup>
            <FieldGroup
                label="Custom Login Script"
                hint="Path to a script handling non-standard login flows (SSO, MFA, etc.)."
            >
                <input
                    type="text"
                    value={(val("auth", "customLoginScript") as string) ?? ""}
                    onChange={(e) => update("auth", "customLoginScript", e.target.value)}
                    placeholder="scripts/login.ts"
                />
            </FieldGroup>
        </>
    );
}
