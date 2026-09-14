import { SystemPageLayout } from '../../components/system/SystemPageLayout';
import type { FieldConfig } from '../../components/system/EntityTable';
import { programOps } from '../../lib/graphql/operations';

const fields: FieldConfig[] = [
  { key: 'programId', label: 'Program', mono: true },
  { key: 'milestoneId', label: 'Milestone', mono: true },
  { key: 'milestoneName', label: 'Name' },
  { key: 'confidence', label: 'Confidence' },
  { key: 'spi', label: 'SPI', mono: true },
  { key: 'cpi', label: 'CPI', mono: true },
  { key: 'status', label: 'Status', type: 'badge', badgeMap: 'status' },
];

export function ProgramPage() {
  return (
    <SystemPageLayout
      title="Program Management"
      description="Milestones, earned value, risk register, delivery schedule"
      primaryKey="PK"
      fields={fields}
      entityLabel="Program Record"
      createDefaults={{ PK: 'PROGRAM#ARES-1', programId: 'ARES-1' }}
      listQuery={programOps.list}
      listQueryName="listProgramRecords"
      createMutation={programOps.create}
      subscriptionQuery={programOps.sub}
      subscriptionName="onCreateProgramRecord"
    />
  );
}
