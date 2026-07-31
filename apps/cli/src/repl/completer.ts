/**
 * Re-exports from the chat slash registry for backward compatibility.
 * The registry in repl/chat/slash/registry.ts is the single source of truth.
 */
export {
    matchSlashCommands,
    type ParsedSlashLine,
    parseSlashLine,
    renderSlashMenu,
    resolveSlashCommand,
    SLASH_COMMAND_REGISTRY,
    SLASH_COMMANDS,
    type SlashCommandDefinition,
    type SlashCommandGroup,
    shouldShowSlashMenu,
    slashCompleter,
} from "./chat/slash/registry";
