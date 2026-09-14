import { DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { Kafka } from 'kafkajs';
import { generateAuthToken } from 'aws-msk-iam-sasl-signer-js';
import { randomUUID } from 'crypto';
import { deriveMESEventType } from './derive-event-type';

const BOOTSTRAP_SERVERS = process.env.BOOTSTRAP_SERVERS!;
const TOPIC = process.env.MSK_TOPIC || 'aerospace.mes.events';
const DOMAIN = process.env.DOMAIN || 'MES';
const SOURCE_SYSTEM = process.env.SOURCE_SYSTEM || 'mes-demo';
const ENTITY_TYPE = process.env.ENTITY_TYPE || 'WorkOrder';
const REGION = process.env.AWS_REGION || 'eu-west-1';

async function oauthBearerTokenProvider() {
  const response = await generateAuthToken({ region: REGION });
  return { value: response.token };
}

const kafka = new Kafka({
  clientId: 'mes-producer',
  brokers: BOOTSTRAP_SERVERS.split(','),
  ssl: true,
  sasl: {
    mechanism: 'oauthbearer' as any,
    oauthBearerProvider: oauthBearerTokenProvider as any,
  },
});

function buildDiff(
  newImage: Record<string, any>,
  oldImage: Record<string, any> | null,
): Record<string, { from: any; to: any }> | null {
  if (!oldImage) return null;
  const diff: Record<string, { from: any; to: any }> = {};
  for (const key of Object.keys(newImage)) {
    if (key === 'PK' || key === 'SK') continue;
    const oldVal = oldImage[key] ?? null;
    const newVal = newImage[key] ?? null;
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      diff[key] = { from: oldVal, to: newVal };
    }
  }
  return Object.keys(diff).length > 0 ? diff : null;
}

function processRecord(record: DynamoDBRecord) {
  if (record.eventName === 'REMOVE') return null;
  if (!record.dynamodb?.NewImage) return null;

  const newImage = unmarshall(record.dynamodb.NewImage as any);
  const oldImage = record.dynamodb.OldImage
    ? unmarshall(record.dynamodb.OldImage as any)
    : null;

  const eventType = deriveMESEventType(newImage, oldImage);
  if (!eventType) return null;

  const eventId = randomUUID();
  const entityId = newImage.workOrderId || newImage.PK;

  return {
    eventId,
    eventType,
    eventVersion: '1.0',
    domain: DOMAIN,
    sourceSystem: SOURCE_SYSTEM,
    // Event time = when the record actually changed (preserves seeded 90-day history);
    // falls back to ingestion time for any record without a payload timestamp.
    occurredAt: newImage.updatedAt || newImage.createdAt || new Date().toISOString(),
    correlationId: newImage.correlationId || eventId,
    entityId,
    entityType: ENTITY_TYPE,
    actor: {
      userId: newImage.assignedOperator || newImage.lastModifiedBy || 'system',
      system: SOURCE_SYSTEM,
    },
    payload: newImage,
    diff: buildDiff(newImage, oldImage),
    metadata: {
      streamSequenceNumber: record.dynamodb?.SequenceNumber || '',
      streamArn: record.eventSourceARN || '',
    },
  };
}

let topicCreated = false;

async function ensureTopic() {
  if (topicCreated) return;
  const admin = kafka.admin();
  await admin.connect();
  try {
    const topics = await admin.listTopics();
    if (!topics.includes(TOPIC)) {
      await admin.createTopics({
        topics: [{ topic: TOPIC, numPartitions: 3, replicationFactor: 2 }],
      });
      console.log(`Created topic ${TOPIC}`);
    }
    topicCreated = true;
  } finally {
    await admin.disconnect();
  }
}

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  const messages = event.Records
    .map(processRecord)
    .filter((m): m is NonNullable<typeof m> => m !== null);

  if (messages.length === 0) return;

  await ensureTopic();

  const producer = kafka.producer();
  await producer.connect();

  try {
    await producer.send({
      topic: TOPIC,
      messages: messages.map((m) => ({
        key: m.entityId,
        value: JSON.stringify(m),
      })),
    });
    console.log(`Published ${messages.length} events to ${TOPIC}:`,
      messages.map((m) => `${m.eventType}:${m.entityId}`).join(', '));
  } finally {
    await producer.disconnect();
  }
};
