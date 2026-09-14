import { SystemPageLayout } from '../../components/system/SystemPageLayout';
import type { FieldConfig } from '../../components/system/EntityTable';
import { wmsOps } from '../../lib/graphql/operations';

const fields: FieldConfig[] = [
  { key: 'kitId', label: 'Kit ID', mono: true },
  { key: 'workOrderId', label: 'Work Order', mono: true },
  { key: 'partNumber', label: 'Part', mono: true },
  { key: 'status', label: 'Status', type: 'badge', badgeMap: 'status' },
  { key: 'requiredQty', label: 'Required' },
  { key: 'stagedQty', label: 'Staged' },
  { key: 'locationId', label: 'Location', mono: true },
];

export function WMSPage() {
  return (
    <SystemPageLayout
      title="Warehouse Management System"
      description="Kitting, staging, material consumption"
      primaryKey="PK"
      fields={fields}
      entityLabel="Kit"
      createDefaults={{ PK: 'KIT#NEW', status: 'PENDING' }}
      listQuery={wmsOps.list}
      listQueryName="listWmsRecords"
      createMutation={wmsOps.create}
      subscriptionQuery={wmsOps.sub}
      subscriptionName="onCreateWmsRecord"
    />
  );
}
