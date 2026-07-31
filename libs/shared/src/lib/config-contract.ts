import { z } from "zod";
import { AI_PROVIDER_IDS } from "./config-public";

/** Shared tRPC input schema for explicit secret-clear instructions. */
export const clearSecretsInputSchema = z
    .array(
        z
            .string()
            .refine(
                (value) =>
                    value === "ai.apiKey" ||
                    value === "auth.credentials.username" ||
                    value === "auth.credentials.password" ||
                    value === "integrations.github.token" ||
                    value === "integrations.jira.apiToken" ||
                    value === "integrations.linear.apiKey" ||
                    (value.startsWith("ai.apiKeys.") &&
                        (AI_PROVIDER_IDS as readonly string[]).includes(
                            value.slice("ai.apiKeys.".length),
                        )),
                "Unknown secret path",
            ),
    )
    .optional();
