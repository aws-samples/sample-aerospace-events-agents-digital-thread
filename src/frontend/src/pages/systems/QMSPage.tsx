import { SystemPageLayout } from '../../components/system/SystemPageLayout';
import type { FieldConfig } from '../../components/system/EntityTable';
import * as ops from '../../lib/graphql/operations';

const fields: FieldConfig[] = [
  { key: 'ncrId', label: 'NCR ID', readOnly: true, mono: true },
  { key: 'partNumber', label: 'Part Number', mono: true },
  { key: 'defectCode', label: 'Defect Code', mono: true },
  { key: 'severity', label: 'Severity', type: 'badge', badgeMap: 'severity' },
  { key: 'supplierId', label: 'Supplier' },
  { key: 'lotNumber', label: 'Lot', mono: true },
  { key: 'status', label: 'Status', type: 'badge', badgeMap: 'status' },
];

export function QMSPage() {
  return (
    <SystemPageLayout
      title="Quality Management System"
      description="Non-conformance reports, corrective actions, inspections"
      primaryKey="ncrId"
      fields={fields}
      entityLabel="NonConformance"
      createDefaults={{ status: 'OPEN', severity: 'MINOR' }}
      listQuery={ops.listNonConformances}
      listQueryName="listNonConformances"
      createMutation={ops.createNonConformance}
      subscriptionQuery={ops.onCreateNonConformance}
      subscriptionName="onCreateNonConformance"
    />
  );
}
