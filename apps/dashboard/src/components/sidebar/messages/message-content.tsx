import { useRef, useState } from "react";
import Markdown from "react-markdown";

interface MessageContentProps {
    content: string;
    isUser?: boolean;
    onOpenInEditor: (code: string, language: string) => void;
}

function CodeBlockPre({
    children,
    onOpenInEditor,
}: {
    children?: React.ReactNode;
    onOpenInEditor: (code: string, language: string) => void;
}) {
    const codeElement = children as React.ReactElement<{ className?: string }>;
    const langClass = codeElement?.props?.className || "";
    const language = langClass.replace("language-", "").replace("code-block ", "");
    const [copied, setCopied] = useState(false);
    const preRef = useRef<HTMLPreElement>(null);

    const getCodeContent = () => preRef.current?.textContent || "";

    const handleCopy = () => {
        navigator.clipboard.writeText(getCodeContent());
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="code-block-wrapper">
            <div className="code-block-header">
                <span className="code-lang">{language || "code"}</span>
                <div className="code-block-actions">
                    <button
                        type="button"
                        className="code-action-btn"
                        onClick={handleCopy}
                        title="Copy code"
                    >
                        {copied ? (
                            <svg
                                aria-hidden="true"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                            >
                                <path d="M5 13l4 4L19 7" />
                            </svg>
                        ) : (
                            <svg
                                aria-hidden="true"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                            >
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                            </svg>
                        )}
                    </button>
                    <button
                        type="button"
                        className="code-action-btn"
                        onClick={() => onOpenInEditor(getCodeContent(), language)}
                        title="Open in editor"
                    >
                        <svg
                            aria-hidden="true"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                        >
                            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                            <polyline points="15 3 21 3 21 9" />
                            <line x1="10" y1="14" x2="21" y2="3" />
                        </svg>
                    </button>
                </div>
            </div>
            <pre ref={preRef} className="code-pre">
                {children}
            </pre>
        </div>
    );
}

export function MessageContent({ content, isUser = false, onOpenInEditor }: MessageContentProps) {
    if (isUser) {
        const mentionRegex = /@([\w/.-]+)/g;
        const parts: React.ReactNode[] = [];
        let lastIndex = 0;

        for (const match of content.matchAll(mentionRegex)) {
            if (match.index > lastIndex) {
                parts.push(content.substring(lastIndex, match.index));
            }
            parts.push(
                <span key={match.index} className="file-mention">
                    @{match[1]}
                </span>,
            );
            lastIndex = match.index + match[0].length;
        }

        if (lastIndex < content.length) {
            parts.push(content.substring(lastIndex));
        }

        return <>{parts.length > 0 ? parts : content}</>;
    }

    return (
        <Markdown
            components={{
                code: ({ className, children, ...props }) => {
                    const isInline = !className;
                    return isInline ? (
                        <code className="inline-code" {...props}>
                            {children}
                        </code>
                    ) : (
                        <code className={`code-block ${className || ""}`} {...props}>
                            {children}
                        </code>
                    );
                },
                pre: ({ children }) => (
                    <CodeBlockPre onOpenInEditor={onOpenInEditor}>{children}</CodeBlockPre>
                ),
                a: ({ href, children }) => (
                    <a href={href} target="_blank" rel="noopener noreferrer" className="md-link">
                        {children}
                    </a>
                ),
                ul: ({ children }) => <ul className="md-list">{children}</ul>,
                ol: ({ children }) => <ol className="md-list md-list-ordered">{children}</ol>,
                li: ({ children }) => <li className="md-list-item">{children}</li>,
                h1: ({ children }) => <h1 className="md-heading md-h1">{children}</h1>,
                h2: ({ children }) => <h2 className="md-heading md-h2">{children}</h2>,
                h3: ({ children }) => <h3 className="md-heading md-h3">{children}</h3>,
                blockquote: ({ children }) => (
                    <blockquote className="md-blockquote">{children}</blockquote>
                ),
                table: ({ children }) => <table className="md-table">{children}</table>,
                th: ({ children }) => <th className="md-th">{children}</th>,
                td: ({ children }) => <td className="md-td">{children}</td>,
            }}
        >
            {content}
        </Markdown>
    );
}

export function openCodeInEditor(
    code: string,
    language: string,
    onFileSelect?: (filePath: string) => void,
) {
    const ext =
        language === "typescript" || language === "ts"
            ? "ts"
            : language === "javascript" || language === "js"
              ? "js"
              : language === "tsx"
                ? "tsx"
                : language === "jsx"
                  ? "jsx"
                  : language === "python"
                    ? "py"
                    : language === "css"
                      ? "css"
                      : language === "html"
                        ? "html"
                        : "txt";
    const fileName = `scratch-${Date.now()}.${ext}`;
    sessionStorage.setItem(`scratch:${fileName}`, code);
    onFileSelect?.(`scratch:${fileName}`);
}

export function openHitlTestInEditor(
    hitl: { testCode?: string; testName?: string; suggestedPath?: string },
    onFileSelect?: (filePath: string) => void,
) {
    const code = hitl.testCode ?? "";
    if (!code) return;
    const rawName =
        hitl.testName ||
        hitl.suggestedPath?.split("/").pop() ||
        `raiken-test-${Date.now()}.spec.ts`;
    let safeName = rawName.replace(/[^\w.-]/g, "-");
    if (!/\.(ts|tsx|js|jsx)$/.test(safeName)) {
        safeName = `${safeName}.spec.ts`;
    }
    const scratchName = `scratch:${safeName}`;
    sessionStorage.setItem(scratchName, code);
    onFileSelect?.(scratchName);
}
