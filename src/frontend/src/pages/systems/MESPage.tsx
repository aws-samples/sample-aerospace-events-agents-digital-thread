import { SystemPageLayout } from '../../components/system/SystemPageLayout';
import type { FieldConfig } from '../../components/system/EntityTable';
import * as ops from '../../lib/graphql/operations';

const fields: FieldConfig[] = [
  { key: 'workOrderId', label: 'Work Order', readOnly: true, mono: true },
  { key: 'partNumber', label: 'Part Number', mono: true },
  { key: 'serialNumber', label: 'Serial', mono: true },
  { key: 'status', label: 'Status', type: 'badge', badgeMap: 'status' },
  { key: 'cell', label: 'Cell', mono: true },
  { key: 'operationNumber', label: 'Operation', mono: true },
  { key: 'assignedOperator', label: 'Operator' },
  { key: 'holdReason', label: 'Hold Reason' },
];

export function MESPage() {
  return (
    <SystemPageLayout
      title="Manufacturing Execution System"
      description="Work orders, operations, labor tracking, holds"
      primaryKey="workOrderId"
      fields={fields}
      entityLabel="Work Order"
      createDefaults={{ status: 'STARTED' }}
      listQuery={ops.listWorkOrders}
      listQueryName="listWorkOrders"
      createMutation={ops.createWorkOrder}
      subscriptionQuery={ops.onCreateWorkOrder}
      subscriptionName="onCreateWorkOrder"
    />
  );
}
