import {
  type ComponentType,
  lazy,
  type PropsWithChildren,
  Suspense,
} from "react";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";

const ReactMarkdown = lazy(() => import("react-markdown"));

// Prism-light and styles have no type declarations — cast to a component with children
type HighlighterProps = PropsWithChildren<{
  language: string;
  style: any;
  customStyle?: React.CSSProperties;
  wrapLongLines?: boolean;
}>;
const SyntaxHighlighter = lazy(() =>
  // @ts-expect-error — no type declarations for prism-light subpath
  import("react-syntax-highlighter/dist/esm/prism-light").then((m) => ({
    default: (m.default ?? m) as ComponentType<HighlighterProps>,
  })),
);

// @ts-expect-error — no type declarations for style subpath
import vscDarkPlus from "react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus";

interface LazyMarkdownProps {
  content: string;
  className?: string;
}

export function LazyMarkdown({ content, className }: LazyMarkdownProps) {
  return (
    <Suspense
      fallback={
        <div className="p-4 text-slate-500 text-sm animate-pulse">
          Rendering...
        </div>
      }
    >
      <LazyMarkdownInner content={content} className={className} />
    </Suspense>
  );
}

function LazyMarkdownInner({ content, className }: LazyMarkdownProps) {
  return (
    <div
      className={
        className ??
        "prose prose-invert prose-sm max-w-none prose-pre:bg-slate-950 prose-pre:border prose-pre:border-slate-800 p-4"
      }
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw]}
        components={{
          code({ node, className: codeClassName, children, ...props }: any) {
            const match = /language-(\S+)/.exec(codeClassName || "");
            const inline = !match;
            return !inline && match ? (
              <Suspense
                fallback={
                  <pre className="bg-slate-950 p-4 rounded text-xs">
                    <code>{String(children)}</code>
                  </pre>
                }
              >
                <SyntaxHighlighter
                  language={match[1]}
                  style={vscDarkPlus}
                  customStyle={{
                    margin: 0,
                    padding: "1rem",
                    background: "transparent",
                    fontSize: "11px",
                    lineHeight: "1.5",
                  }}
                  wrapLongLines
                >
                  {String(children).replace(/\n$/, "")}
                </SyntaxHighlighter>
              </Suspense>
            ) : (
              <code className={codeClassName} {...props}>
                {children}
              </code>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

interface LazySyntaxHighlighterProps {
  code: string;
  language?: string;
}

export function LazySyntaxHighlighter({
  code,
  language = "json",
}: LazySyntaxHighlighterProps) {
  return (
    <Suspense
      fallback={
        <pre className="bg-slate-950 p-4 rounded text-xs font-mono">
          <code>{code}</code>
        </pre>
      }
    >
      <SyntaxHighlighter
        language={language}
        style={vscDarkPlus}
        customStyle={{
          margin: 0,
          padding: "1rem",
          background: "transparent",
          fontSize: "11px",
          lineHeight: "1.5",
        }}
        wrapLongLines
      >
        {code}
      </SyntaxHighlighter>
    </Suspense>
  );
}
