import { accent, dim } from "../../../agent-stream";
import { SLASH_COMMAND_REGISTRY, type SlashCommandGroup } from "./registry";

export function printSlashHelp(): void {
    const row = (c: string, d: string) => console.log(`  ${accent(c.padEnd(24))} ${dim(d)}`);
    console.log(accent("\n  Commands"));
    console.log(dim('  Just type a request in plain English (e.g. "test the login flow").'));
    console.log(dim("  End a line with \\ to continue multiline input."));
    console.log(dim("  Type while a run is in progress to queue the next turn."));
    console.log(dim("  !cmd runs a local shell command (e.g. !git status)."));
    const groups: SlashCommandGroup[] = [
        "Agent",
        "Browser / DOM",
        "Knowledge",
        "Testing",
        "Session",
    ];
    for (const group of groups) {
        console.log(dim(`  ─ ${group} ─`));
        for (const command of SLASH_COMMAND_REGISTRY.filter((item) => item.group === group)) {
            const usage = `/${command.name}${command.argsHint ? ` ${command.argsHint}` : ""}`;
            const aliases = command.aliases?.length
                ? ` (alias: ${command.aliases.map((alias) => `/${alias}`).join(", ")})`
                : "";
            row(usage, `${command.description}${aliases}`);
        }
    }
    console.log(dim("  ─ Standalone terminal commands ─"));
    row("raiken init", "initialize Raiken in a project");
    row("raiken start", "start the dashboard and API server");
    row('raiken -p "..."', "run one non-interactive agent request");
    row("raiken --help", "show every standalone option and flag");
    console.log(dim("\n  Ctrl+C  stop run → cancel prompt → press again to exit"));
    console.log(dim("  Tab completes /commands  ·  raiken resume [name]\n"));
}
