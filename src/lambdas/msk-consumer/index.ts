import { MSKEvent } from 'aws-lambda';
import { FirehoseClient, PutRecordBatchCommand } from '@aws-sdk/client-firehose';

const FIREHOSE_STREAM = process.env.FIREHOSE_STREAM_NAME || '';
const firehose = FIREHOSE_STREAM ? new FirehoseClient({}) : null;

export const handler = async (event: MSKEvent): Promise<void> => {
  const records: { Data: Uint8Array }[] = [];

  for (const [topic, partitionRecords] of Object.entries(event.records)) {
    for (const record of partitionRecords) {
      const value = Buffer.from(record.value, 'base64').toString('utf-8');
      try {
        const parsed = JSON.parse(value);
        console.log(JSON.stringify({
          topic,
          partition: record.partition,
          offset: record.offset,
          eventType: parsed.eventType,
          domain: parsed.domain,
          entityId: parsed.entityId,
        }));

        // Forward to Firehose if configured
        if (firehose) {
          records.push({ Data: Buffer.from(value) });
        }
      } catch {
        console.log(`Raw message on ${topic}:`, value);
      }
    }
  }

  // Batch send to Firehose
  if (firehose && records.length > 0) {
    await firehose.send(new PutRecordBatchCommand({
      DeliveryStreamName: FIREHOSE_STREAM,
      Records: records,
    }));
    console.log(`Forwarded ${records.length} records to Firehose ${FIREHOSE_STREAM}`);
  }
};
