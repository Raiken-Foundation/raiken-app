import { matchSlashCommands } from "../../../utils/slash-commands";

export function checkSlashAutocomplete(
    value: string,
    setShow: (show: boolean) => void,
    setMatches: (matches: ReturnType<typeof matchSlashCommands>) => void,
    setPosition: (pos: number) => void,
): boolean {
    const trimmed = value.trimStart();
    if (!trimmed.startsWith("/")) {
        setShow(false);
        return false;
    }
    const body = trimmed.slice(1);
    const firstSpace = body.search(/\s/);
    if (firstSpace !== -1) {
        setShow(false);
        return true;
    }
    const matches = matchSlashCommands(body);
    setMatches(matches);
    setShow(matches.length > 0);
    setPosition(0);
    return true;
}

export function checkFileMentionAutocomplete(
    value: string,
    cursorPos: number,
    sourceFiles: Array<{ path: string; name: string }>,
    setShow: (show: boolean) => void,
    setFiltered: (files: Array<{ path: string; name: string }>) => void,
    setPosition: (pos: number) => void,
): void {
    const textBeforeCursor = value.slice(0, cursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf("@");

    if (lastAtIndex === -1) {
        setShow(false);
        return;
    }

    const afterAt = textBeforeCursor.slice(lastAtIndex + 1);
    const hasSpaceAfterAt = afterAt.includes(" ");

    if (hasSpaceAfterAt || cursorPos - lastAtIndex > 50 || sourceFiles.length === 0) {
        setShow(false);
        return;
    }

    if (lastAtIndex === cursorPos - 1) {
        setFiltered(sourceFiles);
        setShow(true);
        setPosition(0);
        return;
    }

    const searchTerm = afterAt;
    const filtered = sourceFiles.filter(
        (file) =>
            file.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            file.path.toLowerCase().includes(searchTerm.toLowerCase()),
    );
    setFiltered(filtered);
    setShow(filtered.length > 0);
    setPosition(0);
}

export function insertFileMention(
    inputValue: string,
    cursorPos: number,
    file: { path: string; name: string },
): { value: string; cursorPos: number } {
    const textBeforeCursor = inputValue.slice(0, cursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf("@");
    if (lastAtIndex === -1) return { value: inputValue, cursorPos };

    const beforeAt = inputValue.slice(0, lastAtIndex);
    const afterCursor = inputValue.slice(cursorPos);
    const value = `${beforeAt}@${file.path} ${afterCursor}`;
    const newCursorPos = lastAtIndex + file.path.length + 2;
    return { value, cursorPos: newCursorPos };
}

export function extractFileMentions(input: string): string[] {
    const mentionRegex = /@([^\s]+)/g;
    return [...input.matchAll(mentionRegex)].map((match) => match[1]);
}

export function collectHistoricalFileMentions(messages: Array<{ content: string }>): string[] {
    const mentionRegex = /@([^\s]+)/g;
    const historicalFiles = new Set<string>();
    for (const msg of messages) {
        for (const match of msg.content.matchAll(mentionRegex)) {
            historicalFiles.add(match[1]);
        }
    }
    return [...historicalFiles];
}
