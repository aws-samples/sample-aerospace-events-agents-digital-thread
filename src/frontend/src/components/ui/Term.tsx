/**
 * Inline jargon gloss. Wrap a bare acronym so a non-specialist can decode it on hover
 * (and it's marked with a dotted underline so they know a definition exists). One shared
 * glossary for the metric acronyms that recur across dashboards.
 */

export const TERM_GLOSS: Record<string, string> = {
  CPI: 'Cost Performance Index — earned value ÷ actual cost. >1 = under budget.',
  SPI: 'Schedule Performance Index — earned value ÷ planned value. >1 = ahead of schedule.',
  OEE: 'Overall Equipment Effectiveness — % of ideal machine output actually achieved.',
  OTD: 'On-Time Delivery — % of supplier deliveries received by their promised date.',
  NCR: 'Non-Conformance Report — a logged quality defect against a part or process.',
  OOT: 'Out Of Tolerance — a measurement outside the drawing’s allowed range.',
  'Earned value': 'Earned value — progress measured as cost & schedule performance vs the plan.',
};

/** A term with a dotted underline + native tooltip. Falls back to the TERM_GLOSS entry
 *  when no explicit `title` is given. */
export function Term({ children, title }: { children: string; title?: string }) {
  const gloss = title ?? TERM_GLOSS[children] ?? '';
  return (
    <span title={gloss} className="underline decoration-dotted decoration-text-muted/50 underline-offset-2 cursor-help">
      {children}
    </span>
  );
}

/** A tiny "i" affordance for labels where inlining a Term would crowd the text. */
export function InfoDot({ term, title }: { term?: string; title?: string }) {
  const gloss = title ?? (term ? TERM_GLOSS[term] : '') ?? '';
  if (!gloss) return null;
  return (
    <span title={gloss}
      className="inline-flex items-center justify-center w-3 h-3 ml-1 rounded-full border border-text-muted/40 text-[8px] font-mono text-text-muted cursor-help align-middle">
      i
    </span>
  );
}
