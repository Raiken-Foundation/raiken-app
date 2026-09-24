/**
 * `raiken sessions` — list saved agent sessions (one-shot runs; see `raiken -p`).
 */

import chalk from "chalk";
import { dim } from "../agent-stream";
import { cliExit } from "../cli/exit";
import { listSessions, previewMessage } from "../cli/sessions";

interface SessionsCommandOptions {
    json?: boolean;
}

export async function sessionsCommand(options: SessionsCommandOptions): Promise<void> {
    const projectPath = process.cwd();
    const sessions = listSessions(projectPath);

    if (options.json) {
        process.stdout.write(
            `${JSON.stringify(
                {
                    sessions: sessions.map((s) => ({
                        id: s.id,
                        name: s.name,
                        messages: s.messages.length,
                        updatedAt: s.updatedAt,
                        createdAt: s.createdAt,
                        preview: previewMessage(s.messages),
                    })),
                },
                null,
                2,
            )}\n`,
        );
        cliExit(0);
    }

    if (sessions.length === 0) {
        console.log(dim("  No saved sessions."));
        cliExit(0);
    }

    console.log("");
    for (const s of sessions.slice(0, 20)) {
        const when = new Date(s.updatedAt).toLocaleString();
        console.log(
            `  ${chalk.hex("#a78bfa")(s.name.padEnd(20))} ${dim(`${s.messages.length} msgs · ${when}`)}`,
        );
        console.log(`      ${dim(previewMessage(s.messages))}`);
    }
    cliExit(0);
}
