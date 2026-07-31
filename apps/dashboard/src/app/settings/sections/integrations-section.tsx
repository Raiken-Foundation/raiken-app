import { FieldGroup, SecretField } from "../fields/field-controls";
import type { SettingsFormApi } from "../types";

type IntegrationsSectionProps = Pick<
    SettingsFormApi,
    "val" | "valAt" | "update" | "updateAt" | "secretDrafts" | "updateLinearApiKey"
>;

export function IntegrationsSection({
    val,
    valAt,
    update,
    updateAt,
    secretDrafts,
    updateLinearApiKey,
}: IntegrationsSectionProps) {
    return (
        <>
            <FieldGroup
                label="Ticket Provider"
                hint="Which system Raiken links tests/branches to when resolving ticket references."
            >
                <select
                    value={(val("integrations", "provider") as string) ?? "github"}
                    onChange={(e) => update("integrations", "provider", e.target.value)}
                >
                    <option value="github">GitHub</option>
                    <option value="jira">Jira</option>
                    <option value="linear">Linear</option>
                </select>
            </FieldGroup>
            <FieldGroup
                label="GitHub Owner"
                hint="Repository owner/org. Auto-detected from the git remote if left blank."
            >
                <input
                    type="text"
                    value={(valAt(["integrations", "github", "owner"]) as string | undefined) ?? ""}
                    onChange={(e) => updateAt(["integrations", "github", "owner"], e.target.value)}
                    placeholder="my-org"
                />
            </FieldGroup>
            <FieldGroup
                label="GitHub Repo"
                hint="Repository name. Auto-detected from the git remote if left blank."
            >
                <input
                    type="text"
                    value={(valAt(["integrations", "github", "repo"]) as string | undefined) ?? ""}
                    onChange={(e) => updateAt(["integrations", "github", "repo"], e.target.value)}
                    placeholder="my-repo"
                />
            </FieldGroup>
            <FieldGroup label="Jira Base URL" hint="Your Jira instance's base URL.">
                <input
                    type="text"
                    value={(valAt(["integrations", "jira", "host"]) as string | undefined) ?? ""}
                    onChange={(e) => updateAt(["integrations", "jira", "host"], e.target.value)}
                    placeholder="https://your-org.atlassian.net"
                />
            </FieldGroup>
            <FieldGroup
                label="Jira Project Key"
                hint="Project key used when linking tests to Jira issues (e.g. ENG)."
            >
                <input
                    type="text"
                    value={
                        (valAt(["integrations", "jira", "projectKey"]) as string | undefined) ?? ""
                    }
                    onChange={(e) =>
                        updateAt(["integrations", "jira", "projectKey"], e.target.value)
                    }
                    placeholder="ENG"
                />
            </FieldGroup>
            <SecretField
                label="Linear API Key"
                hint="Personal or workspace API key used to look up Linear issues."
                value={secretDrafts.linearApiKey}
                onChange={updateLinearApiKey}
                placeholder={
                    valAt(["integrations", "linear", "apiKeyPresent"])
                        ? "Saved — enter a replacement"
                        : "lin_api_…"
                }
            />
            <FieldGroup
                label="Linear Team Key"
                hint="Team key used when linking tests to Linear issues (e.g. ENG)."
            >
                <input
                    type="text"
                    value={
                        (valAt(["integrations", "linear", "teamKey"]) as string | undefined) ?? ""
                    }
                    onChange={(e) =>
                        updateAt(["integrations", "linear", "teamKey"], e.target.value)
                    }
                    placeholder="ENG"
                />
            </FieldGroup>
            <FieldGroup
                label="Branch Patterns"
                hint="One regex per line, used to extract a ticket ID from the current git branch name."
                align="start"
            >
                <textarea
                    rows={4}
                    value={(
                        (val("integrations", "branchPatterns") as string[] | undefined) ?? []
                    ).join("\n")}
                    onChange={(e) =>
                        update(
                            "integrations",
                            "branchPatterns",
                            e.target.value
                                .split("\n")
                                .map((s) => s.trim())
                                .filter(Boolean),
                        )
                    }
                    placeholder={"feature/([A-Z]+-\\d+)\nbugfix/([A-Z]+-\\d+)"}
                />
            </FieldGroup>
        </>
    );
}
