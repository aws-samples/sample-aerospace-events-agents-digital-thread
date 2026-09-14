type BadgeVariant = {
  bg: string;
  text: string;
  ring: string;
  dot?: string;
};

const SEVERITY: Record<string, BadgeVariant> = {
  MINOR: { bg: 'bg-status-warning-subtle', text: 'text-status-warning-text', ring: 'ring-status-warning/25' },
  MAJOR: { bg: 'bg-orange-50', text: 'text-orange-700', ring: 'ring-orange-400/25' },
  CRITICAL: { bg: 'bg-status-error-subtle', text: 'text-status-error-text', ring: 'ring-status-error/25', dot: 'bg-status-error' },
};

const STATUS: Record<string, BadgeVariant> = {
  OPEN: { bg: 'bg-status-info-subtle', text: 'text-status-info-text', ring: 'ring-status-info/25', dot: 'bg-status-info' },
  DISPOSITIONED: { bg: 'bg-status-purple-subtle', text: 'text-status-purple-text', ring: 'ring-status-purple/25' },
  CLOSED: { bg: 'bg-surface-tertiary', text: 'text-text-muted', ring: 'ring-border/60' },
};

export const BADGE_MAPS = { severity: SEVERITY, status: STATUS } as const;
export type BadgeMapKey = keyof typeof BADGE_MAPS;

type BadgeProps = {
  value: string;
  map: BadgeMapKey;
};

export function Badge({ value, map }: BadgeProps) {
  const v = BADGE_MAPS[map][value];
  if (!v) {
    return <span className="text-xs font-mono text-text-muted">{value}</span>;
  }
  return (
    <span className={`
      inline-flex items-center gap-1.5 px-2 py-0.5 rounded
      text-[11px] font-mono font-medium tracking-wide uppercase
      ring-1 ring-inset ${v.bg} ${v.text} ${v.ring}
    `}>
      {v.dot && (
        <span className={`w-1.5 h-1.5 rounded-full ${v.dot} animate-[pulse-glow_2s_ease-in-out_infinite]`} />
      )}
      {value}
    </span>
  );
}
