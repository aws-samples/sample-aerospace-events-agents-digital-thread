import { SystemPageLayout } from '../../components/system/SystemPageLayout';
import type { FieldConfig } from '../../components/system/EntityTable';
import { plmOps } from '../../lib/graphql/operations';
import { DrawingViewer } from '../../components/system/DrawingViewer';

const fields: FieldConfig[] = [
  { key: 'partNumber', label: 'Part', mono: true },
  { key: 'description', label: 'Description' },
  { key: 'revision', label: 'Rev', mono: true },
  { key: 'maturityState', label: 'Maturity', mono: true },
  { key: 'effectivity', label: 'Effectivity', mono: true },
  { key: 'drawingNumber', label: 'Drawing', mono: true },
  { key: 'ecrId', label: 'ECR', mono: true },
  { key: 'ecoId', label: 'ECO', mono: true },
  { key: 'ecnId', label: 'ECN', mono: true },
  { key: 'bomId', label: 'BOM', mono: true },
  { key: 'status', label: 'Status', type: 'badge', badgeMap: 'status' },
];

export function PLMPage() {
  return (
    <SystemPageLayout
      title="Product Lifecycle Management"
      description="Parts, drawings, BOMs, engineering change orders"
      primaryKey="PK"
      fields={fields}
      entityLabel="Part"
      createDefaults={{ PK: 'PART#NEW', status: 'DRAFT' }}
      listQuery={plmOps.list}
      listQueryName="listPlmRecords"
      createMutation={plmOps.create}
      subscriptionQuery={plmOps.sub}
      subscriptionName="onCreatePlmRecord"
      renderExtra={(items) => {
        const drawings = items.filter((it) => it.drawingS3Key);
        if (drawings.length === 0) return null;
        // Group revisions of the same drawing together, in revision order, so a part's
        // A→B→C evolution reads left-to-right (44821-003's bore tolerance tightening).
        const sorted = [...drawings].sort((a, b) => {
          const dn = String(a.drawingNumber).localeCompare(String(b.drawingNumber));
          return dn !== 0 ? dn : String(a.revisionLetter || a.revision || '')
            .localeCompare(String(b.revisionLetter || b.revision || ''));
        });
        return (
          <div className="mt-6">
            <h3 className="text-[13px] font-bold text-text-primary mb-1">Released Drawings</h3>
            <p className="text-[11px] text-text-tertiary mb-3">
              2D engineering drawings stored as unstructured artifacts (S3), referenced from the part record.
              Multiple revisions of a drawing appear side by side — the latest is RELEASED, earlier ones SUPERSEDED.
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              {sorted.slice(0, 9).map((d) => {
                const superseded = String(d.maturityState || d.status || '').toUpperCase() === 'SUPERSEDED';
                return (
                  <div key={d.drawingS3Key} className="bg-surface-primary border border-border rounded-xl p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[12px] font-mono font-semibold text-text-primary">{d.drawingNumber}</span>
                      <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${superseded ? 'bg-surface-secondary text-text-muted' : 'bg-status-success-subtle text-status-success'}`}>
                        rev {d.revisionLetter || d.revision || ''}{superseded ? ' · superseded' : ''}
                      </span>
                    </div>
                    <DrawingViewer s3Key={d.drawingS3Key} height={260} />
                  </div>
                );
              })}
            </div>
          </div>
        );
      }}
    />
  );
}
