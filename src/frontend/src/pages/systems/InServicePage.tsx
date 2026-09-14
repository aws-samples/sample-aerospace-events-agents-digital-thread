import { SystemPageLayout } from '../../components/system/SystemPageLayout';
import type { FieldConfig } from '../../components/system/EntityTable';
import { inserviceOps } from '../../lib/graphql/operations';

const fields: FieldConfig[] = [
  { key: 'serialNumber', label: 'Serial', mono: true },
  { key: 'parameter', label: 'Parameter', mono: true },
  { key: 'actualValue', label: 'Value', mono: true },
  { key: 'unit', label: 'Unit' },
  { key: 'deviation', label: 'Deviation', mono: true },
  { key: 'status', label: 'Status', type: 'badge', badgeMap: 'status' },
  { key: 'flightHours', label: 'Flight Hrs' },
];

export function InServicePage() {
  return (
    <SystemPageLayout
      title="In-Service / Digital Twin"
      description="Fleet telemetry, digital twin parameters, anomaly detection"
      primaryKey="PK"
      fields={fields}
      entityLabel="Reading"
      createDefaults={{ PK: 'DT#SN-0047', serialNumber: 'SN-0047' }}
      listQuery={inserviceOps.list}
      listQueryName="listInserviceRecords"
      createMutation={inserviceOps.create}
      subscriptionQuery={inserviceOps.sub}
      subscriptionName="onCreateInserviceRecord"
    />
  );
}
