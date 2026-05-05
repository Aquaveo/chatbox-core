import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import styled from "styled-components";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

const MarkdownContainer = styled.div`
  font-size: 0.92rem;
  line-height: 1.45;
  color: inherit;
  min-width: 0;
  max-width: 100%;
  overflow-wrap: break-word;
  word-break: break-word;

  p { margin: 0.3rem 0; }
  ul, ol { margin: 0.3rem 0; padding-left: 1.2rem; }
  li { margin: 0.05rem 0; }
  li > p { margin: 0; }
  li > p + p { margin-top: 0.2rem; }
  ul ul, ol ol, ul ol, ol ul {
    margin: 0.15rem 0;
    padding-left: 1rem;
  }
  h1, h2, h3, h4, h5, h6 {
    margin: 0.45rem 0 0.15rem;
    line-height: 1.25;
    font-weight: 600;
  }
  h1 { font-size: 1.05rem; }
  h2 { font-size: 1rem; }
  h3 { font-size: 0.95rem; }
  h4, h5, h6 { font-size: 0.9rem; }
  strong { font-weight: 600; }
  hr { margin: 0.5rem 0; border: 0; border-top: 1px solid currentColor; opacity: 0.2; }
  blockquote {
    margin: 0.4rem 0;
    padding: 0 0.6rem;
    border-left: 2px solid currentColor;
    opacity: 0.85;
  }
  pre {
    margin: 0.4rem 0;
    border-radius: 6px;
    /* Horizontal scroll WITHIN the pre block instead of expanding the
       parent column. Without this, a long single-line code block (e.g.,
       a JSON tool-call dump) widens the chat bubble and triggers a
       sidebar-level horizontal scrollbar. */
    overflow-x: auto;
    overflow-y: hidden;
    max-width: 100%;
    min-width: 0;
  }
  pre, pre * {
    /* SyntaxHighlighter wraps content in nested divs/spans; without this,
       its inline width: max-content style escapes the pre constraint. */
    max-width: 100%;
    box-sizing: border-box;
  }
  table { border-collapse: collapse; margin: 0.4rem 0; font-size: 0.85rem; }
  th, td { border: 1px solid rgba(0,0,0,0.1); padding: 0.2rem 0.4rem; }
  > :first-child { margin-top: 0; }
  > :last-child { margin-bottom: 0; }
`;

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
      <MarkdownContainer>
        <SyntaxHighlighter style={oneDark} language="json" PreTag="div" wrapLongLines customStyle={{ margin: 0 }}>
          {jsonContent}
        </SyntaxHighlighter>
      </MarkdownContainer>
    );
  }

  return (
    <MarkdownContainer>
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
    </MarkdownContainer>
  );
}