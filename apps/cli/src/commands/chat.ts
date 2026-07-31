export { runChatRepl } from "../repl/chat/run-chat-repl";
export type { ChatCommandOptions } from "../repl/chat/types";

import { runChatRepl } from "../repl/chat/run-chat-repl";
import type { ChatCommandOptions } from "../repl/chat/types";

export async function chatCommand(options: ChatCommandOptions = {}): Promise<void> {
    await runChatRepl(options);
}
