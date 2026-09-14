import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renders agent / LLM prose as markdown. Agent findings and HITL questions come back
 * with **bold**, ## headings, --- rules and GFM pipe tables; rendered raw they show
 * the literal syntax. This renders them with tight, theme-token styling that fits the
 * dense dashboard cards. Raw HTML is NOT enabled (react-markdown's safe default), so
 * agent output can't inject markup.
 *
 * `size` tunes the base type to the surface: 'sm' (12px, dashboard cards) or
 * 'xs' (10px, trace drawer).
 */
export function Markdown({ children, size = 'sm' }: { children: string; size?: 'sm' | 'xs' }) {
  const base = size === 'xs' ? 'text-[10px]' : 'text-[12px]';
  const h = size === 'xs' ? 'text-[10px]' : 'text-[12px]';
  return (
    <div className={`${base} text-text-secondary leading-snug space-y-1.5 break-words`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="leading-snug">{children}</p>,
          strong: ({ children }) => <strong className="font-bold text-text-primary">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          h1: ({ children }) => <p className={`${h} font-bold text-text-primary uppercase tracking-wide mt-1`}>{children}</p>,
          h2: ({ children }) => <p className={`${h} font-bold text-text-primary uppercase tracking-wide mt-1`}>{children}</p>,
          h3: ({ children }) => <p className={`${h} font-bold text-text-primary mt-1`}>{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-4 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-4 space-y-0.5">{children}</ol>,
          li: ({ children }) => <li className="leading-snug">{children}</li>,
          hr: () => <hr className="border-border-soft my-1.5" />,
          code: ({ children }) => <code className="font-mono text-[0.9em] px-1 py-0.5 rounded bg-surface-tertiary text-text-primary">{children}</code>,
          a: ({ children, href }) => <a href={href} className="text-accent underline" target="_blank" rel="noreferrer">{children}</a>,
          table: ({ children }) => (
            <div className="overflow-x-auto -mx-1 my-1">
              <table className="w-full border-collapse text-[0.92em]">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-surface-tertiary">{children}</thead>,
          th: ({ children }) => <th className="border border-border-soft px-2 py-1 text-left font-semibold text-text-primary whitespace-nowrap">{children}</th>,
          td: ({ children }) => <td className="border border-border-soft px-2 py-1 align-top">{children}</td>,
          blockquote: ({ children }) => <blockquote className="border-l-2 border-border pl-2 text-text-tertiary">{children}</blockquote>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
