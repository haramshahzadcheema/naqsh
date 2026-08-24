import { Fragment, useState } from "react";

/** A small, deliberately minimal markdown-lite renderer -- fenced code
 * blocks (with a copy button) and inline `**bold**` / `` `code` `` spans.
 * Not a full markdown parser: Naqsh's own replies are short, templated
 * strings (see `chat/naqshReply.ts`), so this covers what they actually
 * produce rather than pulling in a general-purpose markdown dependency
 * for a handful of formatting cases. */

export function CopyButton({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="message-text__copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function InlineText({ text }: { text: string }): JSX.Element {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter((part) => part.length > 0);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={index}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code key={index} className="mono message-text__inline-code">
              {part.slice(1, -1)}
            </code>
          );
        }
        return <Fragment key={index}>{part}</Fragment>;
      })}
    </>
  );
}

export function MessageText({ text }: { text: string }): JSX.Element {
  const segments = text.split(/```([\s\S]*?)```/g);
  return (
    <>
      {segments.map((segment, index) => {
        const isCode = index % 2 === 1;
        if (isCode) {
          const code = segment.replace(/^\w*\n/, "");
          return (
            <div key={index} className="message-text__code-block">
              <pre className="mono">
                <code>{code}</code>
              </pre>
              <CopyButton text={code} />
            </div>
          );
        }
        return (
          <p key={index} className="conversation-message__text">
            <InlineText text={segment} />
          </p>
        );
      })}
    </>
  );
}
