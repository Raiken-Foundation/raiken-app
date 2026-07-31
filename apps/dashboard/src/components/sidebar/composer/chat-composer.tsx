import type { SlashCommand } from "../../../utils/slash-commands";

interface SlashCommandDropdownProps {
    slashMatches: SlashCommand[];
    slashPosition: number;
    onSelect: (cmd: SlashCommand, event?: React.MouseEvent) => void;
    onHover: (index: number) => void;
}

export function SlashCommandDropdown({
    slashMatches,
    slashPosition,
    onSelect,
    onHover,
}: SlashCommandDropdownProps) {
    return (
        <div className="autocomplete-dropdown slash-dropdown">
            <div className="slash-dropdown-head">
                <span>slash commands</span>
                <span className="slash-dropdown-hint">
                    ↑↓ navigate · tab to pick · enter to run
                </span>
            </div>
            {slashMatches.map((cmd, index) => (
                <button
                    key={cmd.name}
                    type="button"
                    className={`autocomplete-item slash-item ${index === slashPosition ? "active" : ""}`}
                    onClick={(e) => onSelect(cmd, e)}
                    onMouseEnter={() => onHover(index)}
                >
                    <span className="slash-token">
                        /{cmd.name}
                        {cmd.argsHint && <span className="slash-args">{` ${cmd.argsHint}`}</span>}
                    </span>
                    <span className="slash-desc">{cmd.description}</span>
                </button>
            ))}
        </div>
    );
}

interface FileMentionDropdownProps {
    filteredFiles: Array<{ path: string; name: string }>;
    autocompletePosition: number;
    onSelect: (file: { path: string; name: string }, event?: React.MouseEvent) => void;
    onHover: (index: number) => void;
}

export function FileMentionDropdown({
    filteredFiles,
    autocompletePosition,
    onSelect,
    onHover,
}: FileMentionDropdownProps) {
    return (
        <div className="autocomplete-dropdown">
            {filteredFiles.map((file, index) => (
                <button
                    key={file.path}
                    type="button"
                    className={`autocomplete-item ${index === autocompletePosition ? "active" : ""}`}
                    onClick={(e) => onSelect(file, e)}
                    onMouseEnter={() => onHover(index)}
                >
                    <svg
                        aria-hidden="true"
                        className="file-icon"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                    >
                        <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <div className="file-info">
                        <span className="file-name">{file.name}</span>
                        <span className="file-path">{file.path}</span>
                    </div>
                </button>
            ))}
        </div>
    );
}

interface ChatComposerProps {
    formRef: React.RefObject<HTMLFormElement | null>;
    inputRef: React.RefObject<HTMLTextAreaElement | null>;
    inputValue: string;
    isGenerating: boolean;
    showSlashAutocomplete: boolean;
    showAutocomplete: boolean;
    slashMatches: SlashCommand[];
    slashPosition: number;
    filteredFiles: Array<{ path: string; name: string }>;
    autocompletePosition: number;
    onSubmit: (e: React.FormEvent) => void;
    onInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
    onInputClick: (e: React.MouseEvent<HTMLTextAreaElement>) => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
    onSelectSlash: (cmd: SlashCommand, event?: React.MouseEvent) => void;
    onSelectFile: (file: { path: string; name: string }, event?: React.MouseEvent) => void;
    onSlashHover: (index: number) => void;
    onFileHover: (index: number) => void;
    onStop: () => void;
}

export function ChatComposer({
    formRef,
    inputRef,
    inputValue,
    isGenerating,
    showSlashAutocomplete,
    showAutocomplete,
    slashMatches,
    slashPosition,
    filteredFiles,
    autocompletePosition,
    onSubmit,
    onInputChange,
    onInputClick,
    onKeyDown,
    onSelectSlash,
    onSelectFile,
    onSlashHover,
    onFileHover,
    onStop,
}: ChatComposerProps) {
    return (
        <form ref={formRef} className="chat-input-container" onSubmit={onSubmit}>
            {showSlashAutocomplete && (
                <SlashCommandDropdown
                    slashMatches={slashMatches}
                    slashPosition={slashPosition}
                    onSelect={onSelectSlash}
                    onHover={onSlashHover}
                />
            )}
            {showAutocomplete && (
                <FileMentionDropdown
                    filteredFiles={filteredFiles}
                    autocompletePosition={autocompletePosition}
                    onSelect={onSelectFile}
                    onHover={onFileHover}
                />
            )}
            <textarea
                ref={inputRef}
                rows={1}
                className="chat-input"
                placeholder={
                    isGenerating
                        ? "running… press Esc or Stop to interrupt"
                        : "write a test, or / for commands"
                }
                value={inputValue}
                onChange={onInputChange}
                onClick={onInputClick}
                onKeyDown={onKeyDown}
            />
            {isGenerating ? (
                <button
                    type="button"
                    className="send-btn stop-btn"
                    onClick={onStop}
                    title="Stop the running agent (Esc)"
                    aria-label="Stop the running agent"
                >
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                        <rect x="6" y="6" width="12" height="12" rx="2" />
                    </svg>
                </button>
            ) : (
                <button type="submit" className="send-btn" aria-label="Send message">
                    <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                    >
                        <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                    </svg>
                </button>
            )}
        </form>
    );
}
