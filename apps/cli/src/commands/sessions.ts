/**
 * `raiken sessions` — list saved interactive sessions from the terminal.
 * `raiken resume <name>` needs a name; until now those names only existed
 * inside the REPL (`/sessions`), which made resume a dead end for
 * terminal-only users. Mirrors the REPL `/sessions` list.
 */

import chalk from "chalk";
import { dim } from "../agent-stream";
import { cliExit } from "../repl/exit";
import { listSessions, previewMessage } from "../repl/sessions";

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
        console.log(
            dim(
                "  No saved sessions. Start one with `raiken` and save it with " +
                    "`/sessions save <name>` — then `raiken resume <name>` picks it back up.",
            ),
        );
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
    console.log(dim("\n  Resume with: raiken resume <name>"));
    cliExit(0);
}
