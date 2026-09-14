import { Kafka } from 'kafkajs';
import { generateAuthToken } from 'aws-msk-iam-sasl-signer-js';
import { randomUUID } from 'crypto';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';

const BOOTSTRAP_SERVERS = process.env.BOOTSTRAP_SERVERS!;
const TOPIC = process.env.MSK_TOPIC || 'aerospace.scada.events';
const REGION = process.env.AWS_REGION || 'eu-west-1';

// Debounce: SCADA telemetry is 1 Hz, so a sustained fault would otherwise fire one
// agent invocation per second and exhaust the AgentCore session quota. We publish at
// most one anomaly event per (machine, eventType) per cooldown window, using an atomic
// conditional write — the first reading after the window wins, the rest are suppressed.
const DEBOUNCE_TABLE = process.env.DEBOUNCE_TABLE || 'scada-anomaly-debounce';
const COOLDOWN_SECONDS = Number(process.env.DEBOUNCE_SECONDS || 300);
const ddb = new DynamoDBClient({ region: REGION });

async function shouldPublish(machineId: string, eventType: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  try {
    await ddb.send(new PutItemCommand({
      TableName: DEBOUNCE_TABLE,
      Item: {
        PK: { S: `${machineId}#${eventType}` },
        lastPublished: { N: String(now) },
        ttl: { N: String(now + COOLDOWN_SECONDS) },   // row self-expires → next event re-publishes
      },
      // Only succeeds if no un-expired row exists (DynamoDB TTL deletes lazily, so also
      // accept rows whose cooldown has elapsed).
      ConditionExpression: 'attribute_not_exists(PK) OR lastPublished < :cutoff',
      ExpressionAttributeValues: { ':cutoff': { N: String(now - COOLDOWN_SECONDS) } },
    }));
    return true;
  } catch (e: any) {
    if (e.name === 'ConditionalCheckFailedException') return false;  // within cooldown — suppress
    console.error('debounce check failed, allowing publish:', e.name);
    return true;  // fail-open: a missed debounce is better than a dropped fault
  }
}

async function oauthBearerTokenProvider() {
  const response = await generateAuthToken({ region: REGION });
  return { value: response.token };
}

const kafka = new Kafka({
  clientId: 'scada-event-forwarder',
  brokers: BOOTSTRAP_SERVERS.split(','),
  ssl: true,
  sasl: {
    mechanism: 'oauthbearer' as any,
    oauthBearerProvider: oauthBearerTokenProvider as any,
  },
});

let topicCreated = false;

async function ensureTopic() {
  if (topicCreated) return;
  const admin = kafka.admin();
  await admin.connect();
  try {
    const topics = await admin.listTopics();
    if (!topics.includes(TOPIC)) {
      await admin.createTopics({
        topics: [{ topic: TOPIC, numPartitions: 8, replicationFactor: 2 }],
      });
      console.log(`Created topic ${TOPIC}`);
    }
    topicCreated = true;
  } finally {
    await admin.disconnect();
  }
}

function deriveEventType(payload: Record<string, any>): string | null {
  const { metric, status, value, threshold } = payload;

  if (metric === 'status' || status === 'FAULT') return 'MACHINE_FAULT';
  if (status === 'RUNNING' && payload.previousStatus === 'FAULT') return 'MACHINE_RESTORED';
  if (metric === 'oee_percent' && value < (threshold ?? 75)) return 'OEE_THRESHOLD_BREACHED';
  if (metric === 'spindle_vibration_mm_s' && value > (threshold ?? 1.8)) return 'PARAMETER_ANOMALY';

  return null;
}

interface IoTRuleEvent {
  machineId: string;
  cellId: string;
  programId?: string;
  metric: string;
  value: number;
  unit?: string;
  threshold?: number;
  status?: string;
  previousStatus?: string;
  timestamp: string;
  mqttTopic?: string;
}

export const handler = async (event: IoTRuleEvent): Promise<void> => {
  const eventType = deriveEventType(event);
  if (!eventType) {
    console.log('No event type derived, skipping:', JSON.stringify(event));
    return;
  }

  // Suppress sustained-fault floods: at most one event per machine+type per cooldown.
  if (!(await shouldPublish(event.machineId, eventType))) {
    console.log(`Debounced ${eventType} for ${event.machineId} (within ${COOLDOWN_SECONDS}s cooldown)`);
    return;
  }

  const eventId = randomUUID();
  const canonicalEvent = {
    eventId,
    eventType,
    eventVersion: '1.0',
    domain: 'SCADA',
    sourceSystem: 'iot-core',
    occurredAt: event.timestamp || new Date().toISOString(),
    correlationId: eventId,
    entityId: event.machineId,
    entityType: 'Machine',
    actor: { userId: 'system', system: 'iot-core' },
    payload: {
      machineId: event.machineId,
      cellId: event.cellId,
      metric: event.metric,
      value: event.value,
      threshold: event.threshold,
      unit: event.unit,
      status: event.status,
      mqttTopic: event.mqttTopic,
    },
    diff: null,
    metadata: { source: 'iot-rule' },
  };

  await ensureTopic();

  const producer = kafka.producer();
  await producer.connect();
  try {
    await producer.send({
      topic: TOPIC,
      messages: [{ key: event.machineId, value: JSON.stringify(canonicalEvent) }],
    });
    console.log(`Published ${eventType} for ${event.machineId} to ${TOPIC}`);
  } finally {
    await producer.disconnect();
  }
};
