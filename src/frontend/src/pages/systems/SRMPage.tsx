import { SystemPageLayout } from '../../components/system/SystemPageLayout';
import type { FieldConfig } from '../../components/system/EntityTable';
import { srmOps } from '../../lib/graphql/operations';

const fields: FieldConfig[] = [
  { key: 'supplierId', label: 'Supplier ID', mono: true },
  { key: 'supplierName', label: 'Name' },
  { key: 'qualificationStatus', label: 'Status', type: 'badge', badgeMap: 'status' },
  { key: 'otdPercent', label: 'OTD %', mono: true },
  { key: 'qualityScore', label: 'Quality', mono: true },
  { key: 'overallScore', label: 'Overall', mono: true },
  { key: 'period', label: 'Period', mono: true },
];

export function SRMPage() {
  return (
    <SystemPageLayout
      title="Supplier Relationship Management"
      description="Supplier qualification, scorecards, audit tracking"
      primaryKey="PK"
      fields={fields}
      entityLabel="Supplier Score"
      createDefaults={{ PK: 'SUPPLIER#NEW', qualificationStatus: 'QUALIFIED' }}
      listQuery={srmOps.list}
      listQueryName="listSrmRecords"
      createMutation={srmOps.create}
      subscriptionQuery={srmOps.sub}
      subscriptionName="onCreateSrmRecord"
    />
  );
}
