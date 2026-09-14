import { Badge, type BadgeMapKey } from '../ui/Badge';

export type FieldConfig = {
  key: string;
  label: string;
  type?: 'text' | 'badge';
  badgeMap?: BadgeMapKey;
  readOnly?: boolean;
  mono?: boolean;
};

type EntityTableProps = {
  fields: FieldConfig[];
  items: Record<string, any>[];
  primaryKey: string;
};

export function EntityTable({ fields, items, primaryKey }: EntityTableProps) {
  if (items.length === 0) {
    return (
      <div className="py-16 text-center">
        <p className="text-text-tertiary text-sm">No records</p>
        <p className="text-text-muted text-xs mt-1 font-mono">Awaiting first record</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border">
            {fields.map((f) => (
              <th
                key={f.key}
                className="px-4 py-2.5 text-left text-[10px] font-mono font-semibold
                  text-text-muted uppercase tracking-[0.1em]"
              >
                {f.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item, idx) => (
            <tr
              key={item[primaryKey] + (item.SK ? `#${item.SK}` : '') + `-${idx}`}
              className="border-b border-border/60 hover:bg-surface-secondary transition-colors"
              style={{ animation: `fade-in 0.2s ease-out ${idx * 30}ms both` }}
            >
              {fields.map((f) => (
                <td key={f.key} className="px-4 py-2.5">
                  {f.type === 'badge' && f.badgeMap ? (
                    <Badge value={item[f.key] ?? ''} map={f.badgeMap} />
                  ) : (
                    <span className={`text-[13px] ${
                      f.mono || f.key === primaryKey
                        ? 'font-mono text-text-secondary'
                        : 'text-text-primary'
                    }`}>
                      {item[f.key] ?? (
                        <span className="text-text-muted">&mdash;</span>
                      )}
                    </span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
