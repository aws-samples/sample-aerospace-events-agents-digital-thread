/**
 * Firehose transformer Lambda — converts MSK canonical events to flat Iceberg row format.
 * Input: Firehose records (base64 encoded MSK messages)
 * Output: JSON rows matching the aerospace_events.domain_events Iceberg table schema
 */

interface FirehoseRecord {
  recordId: string;
  data: string; // base64 encoded
}

interface FirehoseResult {
  recordId: string;
  result: 'Ok' | 'Dropped' | 'ProcessingFailed';
  data: string; // base64 encoded output
}

export const handler = async (event: { records: FirehoseRecord[] }): Promise<{ records: FirehoseResult[] }> => {
  const results: FirehoseResult[] = event.records.map((record) => {
    try {
      const raw = Buffer.from(record.data, 'base64').toString('utf-8');
      const parsed = JSON.parse(raw);

      // Flatten canonical event to Iceberg row
      const row = {
        event_id: parsed.eventId,
        event_type: parsed.eventType,
        event_version: parsed.eventVersion ?? '1.0',
        domain: parsed.domain,
        source_system: parsed.sourceSystem,
        occurred_at: parsed.occurredAt,
        correlation_id: parsed.correlationId,
        entity_id: parsed.entityId,
        entity_type: parsed.entityType,
        payload: JSON.stringify(parsed.payload),
        diff: parsed.diff ? JSON.stringify(parsed.diff) : null,
        actor_user_id: parsed.actor?.userId ?? 'system',
        actor_system: parsed.actor?.system ?? 'unknown',
        schema_version: parsed.eventVersion ?? '1.0',
      };

      // Firehose expects newline-delimited JSON for Iceberg
      const output = JSON.stringify(row) + '\n';

      return {
        recordId: record.recordId,
        result: 'Ok' as const,
        data: Buffer.from(output).toString('base64'),
      };
    } catch (err) {
      console.error('Failed to transform record:', record.recordId, err);
      return {
        recordId: record.recordId,
        result: 'ProcessingFailed' as const,
        data: record.data,
      };
    }
  });

  return { records: results };
};
