// ISA-95:2018 domain map. See docs/specs/isa95-migration.md.
// MaterialSublot is the central hub (always visible) — it covers both
// serialized units (subtype=Serialized) and kit aggregations (subtype=Kit).
export type DomainName = 'All' | 'Engineering' | 'Manufacturing' | 'Quality' | 'Supply Chain' | 'Fleet' | 'Hierarchy' | 'Personnel';

export const DOMAIN_MAP: Record<Exclude<DomainName, 'All'>, string[]> = {
  Engineering: ['MaterialDefinition', 'ProductDefinitionDocument', 'ECO'],
  Manufacturing: ['JobResponse', 'JobOrder', 'ProcessSegment', 'Equipment', 'AsBuiltRecord'],
  Quality: ['OperationsPerformance', 'ThreadGap', 'CoherenceVerdict'],
  'Supply Chain': ['Supplier', 'MaterialLot', 'PurchaseOrder'],
  Fleet: ['DigitalTwin', 'FleetAnomaly'],
  Hierarchy: ['Enterprise', 'Site', 'Area', 'WorkCenter', 'WorkUnit'],
  Personnel: ['Person', 'PersonnelClass'],
};

export const DOMAIN_COLORS: Record<Exclude<DomainName, 'All'>, string> = {
  Engineering: '#3b82f6',
  Manufacturing: '#f59e0b',
  Quality: '#ef4444',
  'Supply Chain': '#8b5cf6',
  Fleet: '#10b981',
  Hierarchy: '#06b6d4',
  Personnel: '#ec4899',
};

export const DOMAIN_LIST: DomainName[] = ['All', 'Engineering', 'Manufacturing', 'Quality', 'Supply Chain', 'Fleet', 'Hierarchy', 'Personnel'];

// MaterialSublot is the central hub — visible across all domains, never filtered.
const HUB_TYPES = new Set(['MaterialSublot']);

export function getDomain(nodeType: string): DomainName | null {
  if (HUB_TYPES.has(nodeType)) return null;
  for (const [domain, types] of Object.entries(DOMAIN_MAP)) {
    if (types.includes(nodeType)) return domain as DomainName;
  }
  return null;
}

export function isNodeVisible(nodeType: string, activeDomain: DomainName): boolean {
  if (activeDomain === 'All') return true;
  if (HUB_TYPES.has(nodeType)) return true;
  return DOMAIN_MAP[activeDomain]?.includes(nodeType) ?? false;
}
