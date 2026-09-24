import type { Components } from "react-markdown";
import { safeMarkdownHref } from "../model/markdown-utils";

export const interpretationMarkdownComponents: Components = {
    h1: ({ children }) => <h2 className="int-h2">{children}</h2>,
    h2: ({ children }) => <h3 className="int-h3">{children}</h3>,
    h3: ({ children }) => <h4 className="int-h4">{children}</h4>,
    h4: ({ children }) => <h4 className="int-h4">{children}</h4>,
    strong: ({ children }) => <strong className="int-bold">{children}</strong>,
    code: ({ className, children, ...props }) => {
        const isInline = !className;
        return isInline ? (
            <code className="int-inline-code" {...props}>
                {children}
            </code>
        ) : (
            <code className={`int-code-block ${className || ""}`} {...props}>
                {children}
            </code>
        );
    },
    pre: ({ children }) => <pre className="int-pre">{children}</pre>,
    a: ({ href, children }) => {
        const safeHref = safeMarkdownHref(href);
        return safeHref ? (
            <a href={safeHref} target="_blank" rel="noopener noreferrer" className="int-link">
                {children}
            </a>
        ) : (
            <span className="int-link">{children}</span>
        );
    },
    ul: ({ children }) => <ul className="int-list">{children}</ul>,
    ol: ({ children }) => <ol className="int-list int-list-ordered">{children}</ol>,
    blockquote: ({ children }) => <blockquote className="int-blockquote">{children}</blockquote>,
    table: ({ children }) => (
        <div className="int-table-wrap">
            <table className="int-table">{children}</table>
        </div>
    ),
    th: ({ children }) => <th className="int-th">{children}</th>,
    td: ({ children }) => <td className="int-td">{children}</td>,
};
