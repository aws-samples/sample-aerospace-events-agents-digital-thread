import { SystemPageLayout } from '../../components/system/SystemPageLayout';
import type { FieldConfig } from '../../components/system/EntityTable';
import { erpOps } from '../../lib/graphql/operations';

const fields: FieldConfig[] = [
  { key: 'poNumber', label: 'PO', mono: true },
  { key: 'requisitionId', label: 'Requisition', mono: true },
  { key: 'invoiceId', label: 'Invoice', mono: true },
  { key: 'supplierId', label: 'Supplier', mono: true },
  { key: 'partNumber', label: 'Part', mono: true },
  { key: 'currency', label: 'Curr', mono: true },
  { key: 'incoterms', label: 'Incoterms', mono: true },
  { key: 'plantId', label: 'Plant', mono: true },
  { key: 'costCenter', label: 'Cost Ctr', mono: true },
  { key: 'taxCode', label: 'Tax', mono: true },
  { key: 'status', label: 'Status', type: 'badge', badgeMap: 'status' },
];

export function ERPPage() {
  return (
    <SystemPageLayout
      title="Enterprise Resource Planning"
      description="Purchase orders, material receipts, inventory, cost tracking"
      primaryKey="PK"
      fields={fields}
      entityLabel="Purchase Order"
      createDefaults={{ PK: 'PO#NEW', status: 'ISSUED' }}
      listQuery={erpOps.list}
      listQueryName="listErpRecords"
      createMutation={erpOps.create}
      subscriptionQuery={erpOps.sub}
      subscriptionName="onCreateErpRecord"
    />
  );
}
