import { SystemPageLayout } from '../../components/system/SystemPageLayout';
import type { FieldConfig } from '../../components/system/EntityTable';
import { dhrOps } from '../../lib/graphql/operations';

const fields: FieldConfig[] = [
  { key: 'serialNumber', label: 'Serial', mono: true },
  { key: 'operationNumber', label: 'Operation', mono: true },
  { key: 'certType', label: 'Cert Type', mono: true },
  { key: 'testType', label: 'Test Type', mono: true },
  { key: 'result', label: 'Result', type: 'badge', badgeMap: 'status' },
  { key: 'status', label: 'Status', type: 'badge', badgeMap: 'status' },
];

export function DHRPage() {
  return (
    <SystemPageLayout
      title="Device History Record"
      description="Serialized traceability — operations, certs, tests linked to serial numbers"
      primaryKey="PK"
      fields={fields}
      entityLabel="DHR Record"
      createDefaults={{ PK: 'SN#SN-0047', serialNumber: 'SN-0047' }}
      listQuery={dhrOps.list}
      listQueryName="listDhrRecords"
      createMutation={dhrOps.create}
      subscriptionQuery={dhrOps.sub}
      subscriptionName="onCreateDhrRecord"
    />
  );
}
