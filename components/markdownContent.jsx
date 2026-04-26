import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

function formatJsonIfPossible(content) {
  if (content == null) return null;

  if (typeof content === "object") {
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return null;
    }
  }

  if (typeof content !== "string") return null;

  const trimmed = content.trim();

  if (
    !(trimmed.startsWith("{") && trimmed.endsWith("}")) &&
    !(trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return null;
  }

  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

export default function MarkdownContent({ content }) {
  const jsonContent = formatJsonIfPossible(content);

  if (jsonContent) {
    return (
      <div className="max-w-none">
        <SyntaxHighlighter style={oneDark} language="json" PreTag="div" wrapLongLines customStyle={{ margin: 0 }}>
          {jsonContent}
        </SyntaxHighlighter>
      </div>
    );
  }

  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer" />
          ),
          code({ inline, className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || "");

            if (!inline && match) {
              return (
                <SyntaxHighlighter
                  style={oneDark}
                  language={match[1]}
                  PreTag="div"
                  wrapLongLines
                  customStyle={{ margin: 0 }}
                  {...props}
                >
                  {String(children).replace(/\n$/, "")}
                </SyntaxHighlighter>
              );
            }

            return (
              <code
                className="rounded bg-gray-100 px-1 py-0.5 text-sm dark:bg-gray-800"
                {...props}
              >
                {children}
              </code>
            );
          },
        }}
      >
        {String(content ?? "")}
      </ReactMarkdown>
    </div>
  );
}