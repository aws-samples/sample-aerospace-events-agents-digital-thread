/**
 * ISA-95 mapping — single source of truth for translating the native vendor
 * vocabulary that the "legacy" ERP/PLM applications publish into the ISA-95:2018
 * canonical model the rest of the platform consumes.
 *
 * This is the heart of the normalizer step: it illustrates the real-world pattern
 * where a legacy system does not speak your canonical model, so you normalize at
 * the integration boundary. Both the knowledge graph and the datalake read the
 * canonical output, so both end up ISA-95-compliant.
 *
 * Scope notes (consistent with the deployed graph vocabulary):
 *  - PLM design objects map to ISA-95: Part → MaterialDefinition,
 *    Drawing → ProductDefinitionDocument. Engineering-change objects
 *    (ECR/ECO/ECN/BOM) have no native ISA-95 class — kept as project extensions
 *    and tagged isaScope='extension'.
 *  - ERP procurement (PurchaseRequisition / PurchaseOrder / GoodsReceipt /
 *    SupplierInvoice / Supplier) is ISA-95 Level 4 and lies OUTSIDE ISA-95's
 *    Level 3 scope; labels are preserved but tagged isaScope='L4'. Material
 *    references within them (MaterialLot / MaterialDefinition) DO use ISA-95 terms.
 */

export interface CanonicalEvent {
  eventType: string;
  domain: string;
  // ISA-95 canonical entity classification applied by the normalizer:
  isaClass: string;          // canonical ISA-95 (or extension) class name
  isaScope: 'L3' | 'L4' | 'extension';
  payload: Record<string, any>;
  [k: string]: any;          // passthrough of the rest of the envelope
}

/** Vendor eventType → canonical eventType (most pass through unchanged). */
const EVENT_TYPE_CANON: Record<string, string> = {
  // PLM — already authentic; canonical names are identical, listed for clarity.
  PART_RELEASED: 'PART_RELEASED',
  DRAWING_RELEASED: 'DRAWING_RELEASED',
  // ERP — likewise pass-through; the value is in the entity classification below.
};

/**
 * Classify a raw event into its ISA-95 class + scope, keyed by the DDB PK prefix
 * carried on the payload. Returns null for unknown shapes (normalizer passes them
 * through untouched).
 */
function classify(domain: string, payload: Record<string, any>): { isaClass: string; isaScope: 'L3' | 'L4' | 'extension' } | null {
  const pk: string = payload.PK || '';
  const prefix = pk.split('#')[0];

  if (domain === 'PLM') {
    switch (prefix) {
      case 'PART':    return { isaClass: 'MaterialDefinition', isaScope: 'L3' };
      case 'DRAWING': return { isaClass: 'ProductDefinitionDocument', isaScope: 'L3' };
      case 'ECR':     return { isaClass: 'ChangeRequest', isaScope: 'extension' };
      case 'ECO':     return { isaClass: 'EngineeringChangeOrder', isaScope: 'extension' };
      case 'ECN':     return { isaClass: 'ChangeNotice', isaScope: 'extension' };
      case 'BOM':     return { isaClass: 'BillOfMaterials', isaScope: 'extension' };
    }
  }
  if (domain === 'ERP') {
    switch (prefix) {
      case 'PR':      return { isaClass: 'PurchaseRequisition', isaScope: 'L4' };
      case 'PO':      return { isaClass: 'PurchaseOrder', isaScope: 'L4' };
      case 'RECEIPT': return { isaClass: 'GoodsReceipt', isaScope: 'L4' };
      case 'INV':     return { isaClass: 'SupplierInvoice', isaScope: 'L4' };
    }
  }
  return null;
}

/**
 * Field renames vendor → ISA-95 canonical, applied to the payload. Additive and
 * non-destructive: canonical fields are ADDED; the original vendor fields are kept
 * for traceability. Keeps the demo legible (you can see both vocabularies).
 */
const FIELD_CANON: Record<string, Record<string, string>> = {
  PLM: {
    revisionLetter: 'documentRevision',  // Drawing rev → ISA-95 document revision
    revision: 'materialRevision',        // Part rev   → ISA-95 material revision
  },
  ERP: {
    partNumber: 'materialDefinitionId',  // vendor part no → ISA-95 MaterialDefinition id
    lotNumber: 'materialLotId',          // vendor lot     → ISA-95 MaterialLot id
  },
};

function applyFieldCanon(domain: string, payload: Record<string, any>): Record<string, any> {
  const renames = FIELD_CANON[domain];
  if (!renames) return payload;
  const out = { ...payload };
  for (const [vendorKey, canonKey] of Object.entries(renames)) {
    if (vendorKey in out && !(canonKey in out)) out[canonKey] = out[vendorKey];
  }
  return out;
}

/**
 * Normalize one canonical-envelope event (as produced by generic-producer from a
 * raw vendor item) into ISA-95 form. Adds `isaClass` / `isaScope`, canonicalizes
 * the eventType, applies additive field renames, and stamps the source vocabulary
 * for traceability. Unknown shapes pass through with isaScope='extension'.
 */
export function normalizeToIsa95(event: Record<string, any>): CanonicalEvent {
  const domain: string = event.domain || '';
  const payload: Record<string, any> = event.payload || {};

  const cls = classify(domain, payload);
  const canonPayload = applyFieldCanon(domain, payload);

  return {
    ...event,
    domain,
    eventType: EVENT_TYPE_CANON[event.eventType] || event.eventType,
    isaClass: cls?.isaClass || event.entityType || 'Unknown',
    isaScope: cls?.isaScope || 'extension',
    payload: canonPayload,
    sourceVocabulary: 'vendor-native',   // trace: this event was normalized at integration
    normalizedAt: new Date().toISOString(),
  };
}
