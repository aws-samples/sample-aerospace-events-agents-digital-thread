import { type ReactNode, useState, useEffect, useMemo } from 'react';
import { Shield, Activity, ChevronDown } from 'lucide-react';
import { useEventContext } from '../../context/EventProvider';

function useHash() {
  const [hash, setHash] = useState(window.location.hash || '#/dashboard/quality');
  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  return hash;
}

function NavLink({ href, label, currentHash, badge }: { href: string; label: string; currentHash: string; badge?: number }) {
  const isActive = currentHash === href;
  return (
    <a
      href={href}
      className={`relative px-3 py-1 text-[12px] font-medium tracking-wide uppercase rounded-lg border transition-colors ${
        isActive
          ? 'text-band bg-on-band border-transparent font-bold'
          : 'text-on-band-muted bg-transparent border-transparent hover:bg-white/10 hover:text-on-band'
      }`}
    >
      {label}
      {badge != null && badge > 0 && (
        <span
          title={`${badge} decision${badge === 1 ? '' : 's'} awaiting a human in ${label}`}
          className="absolute -top-1.5 -right-1.5 min-w-[16px] h-[16px] flex items-center justify-center px-1 text-[9px] font-bold text-band bg-brand-pink rounded-full">
          {badge}
        </span>
      )}
    </a>
  );
}

const SYSTEM_LINKS = [
  { href: '#/systems/qms', label: 'QMS' },
  { href: '#/systems/mes', label: 'MES' },
  { href: '#/systems/plm', label: 'PLM' },
  { href: '#/systems/erp', label: 'ERP' },
  { href: '#/systems/srm', label: 'SRM' },
  { href: '#/systems/wms', label: 'WMS' },
  { href: '#/systems/dhr', label: 'DHR' },
  { href: '#/systems/program', label: 'Program' },
  { href: '#/systems/inservice', label: 'In-Service' },
];

function SystemsDropdown({ currentHash }: { currentHash: string }) {
  const [open, setOpen] = useState(false);
  const activeSystem = SYSTEM_LINKS.find((s) => currentHash === s.href);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 px-3 py-1 text-[12px] font-medium tracking-wide uppercase rounded-lg border transition-colors ${
          activeSystem
            ? 'text-band bg-on-band border-transparent font-bold'
            : 'text-on-band-muted bg-transparent border-transparent hover:bg-white/10 hover:text-on-band'
        }`}
      >
        {activeSystem ? activeSystem.label : 'Systems'}
        <ChevronDown size={10} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full mt-1 left-0 z-50 bg-surface-primary border border-border rounded-lg shadow-lg py-1 min-w-[140px]">
            {SYSTEM_LINKS.map((s) => (
              <a
                key={s.href}
                href={s.href}
                onClick={() => setOpen(false)}
                className={`block px-3 py-1.5 text-[11px] font-medium tracking-wide uppercase transition-colors ${
                  currentHash === s.href
                    ? 'text-accent bg-accent-subtle'
                    : 'text-text-secondary hover:bg-surface-secondary'
                }`}
              >
                {s.label}
              </a>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

type LayoutProps = { children: ReactNode };

export function Layout({ children }: LayoutProps) {
  const hash = useHash();
  const { hitlAll } = useEventContext();

  // Count pending HITL questions per dashboard domain
  const hitlCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const q of hitlAll) {
      const domain = q.domainId || '';
      counts[domain] = (counts[domain] || 0) + 1;
    }
    if (Object.keys(counts).length > 0) {
      console.log('[Layout] HITL counts:', counts, 'hitlAll:', hitlAll.length);
    }
    return counts;
  }, [hitlAll]);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Top bar */}
      <header className="h-12 bg-band flex items-center px-5 gap-5 shrink-0
        shadow-[0_1px_2px_0_rgb(0_0_0/0.15)] overflow-visible">
        {/* Program badge */}
        <div className="flex items-center gap-2">
          <Shield size={14} className="text-brand-blue" />
          <span className="text-[13px] font-bold tracking-widest text-on-band uppercase">
            ARES-1
          </span>
          <span className="text-[10px] font-mono text-on-band-muted ml-1">
            S/N 0047
          </span>
        </div>

        <div className="w-px h-4 bg-white/20" />

        {/* Dashboard nav */}
        <nav className="flex items-center gap-1 overflow-visible">
          <NavLink href="#/dashboard/quality" label="Quality" currentHash={hash} badge={hitlCounts['quality']} />
          <NavLink href="#/dashboard/shop-floor" label="Shop Floor" currentHash={hash} badge={hitlCounts['shop-floor']} />
          <NavLink href="#/dashboard/supply-chain" label="Supply Chain" currentHash={hash} badge={hitlCounts['supply-chain']} />
          <NavLink href="#/dashboard/program" label="Program" currentHash={hash} badge={hitlCounts['program']} />
          <NavLink href="#/dashboard/in-service" label="Fleet" currentHash={hash} badge={hitlCounts['in-service']} />
          <span className="w-px h-3 bg-white/20 mx-1" />
          <NavLink href="#/digital-thread" label="Thread" currentHash={hash} />
          <NavLink href="#/datalake" label="Analytics" currentHash={hash} />
          <NavLink href="#/agent-observability" label="Agents" currentHash={hash} />
          <span className="w-px h-3 bg-white/20 mx-1" />
          <SystemsDropdown currentHash={hash} />
          <span className="w-px h-3 bg-white/20 mx-1" />
          <NavLink href="#/demo-control" label="Control" currentHash={hash} />
          <NavLink href="#/architecture" label="Arch" currentHash={hash} />
          <NavLink href="#/flow" label="Flow" currentHash={hash} />
        </nav>

        <div className="flex-1" />

        {/* Status */}
        <div className="flex items-center gap-2 text-[11px] font-mono text-on-band-muted">
          <Activity size={12} className="text-brand-green" />
          <span>OPERATIONAL</span>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 p-6">
        {children}
      </main>
    </div>
  );
}
