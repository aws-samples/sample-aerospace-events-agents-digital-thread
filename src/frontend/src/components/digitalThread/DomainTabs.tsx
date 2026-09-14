import { type DomainName, DOMAIN_LIST, DOMAIN_COLORS } from './domainMap';

type DomainTabsProps = {
  active: DomainName;
  onChange: (domain: DomainName) => void;
};

export function DomainTabs({ active, onChange }: DomainTabsProps) {
  return (
    <div className="flex items-center gap-1 bg-surface-tertiary rounded-lg p-0.5">
      {DOMAIN_LIST.map((domain) => {
        const isActive = active === domain;
        const color = domain === 'All' ? undefined : DOMAIN_COLORS[domain];
        return (
          <button
            key={domain}
            onClick={() => onChange(domain)}
            className={`px-3 py-1.5 text-[11px] font-mono font-semibold rounded flex items-center gap-1.5 transition-colors ${
              isActive
                ? 'bg-surface-primary text-text-primary shadow-sm'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {color && (
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: isActive ? color : color + '60' }}
              />
            )}
            {domain}
          </button>
        );
      })}
    </div>
  );
}
