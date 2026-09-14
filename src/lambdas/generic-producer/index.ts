/**
 * Generic DynamoDB Stream → MSK producer.
 * Domain-specific event type derivation based on DOMAIN env var.
 */

import { DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { Kafka } from 'kafkajs';
import { generateAuthToken } from 'aws-msk-iam-sasl-signer-js';
import { randomUUID } from 'crypto';

const BOOTSTRAP_SERVERS = process.env.BOOTSTRAP_SERVERS!;
const TOPIC = process.env.MSK_TOPIC!;
const DOMAIN = process.env.DOMAIN!;
const SOURCE_SYSTEM = process.env.SOURCE_SYSTEM!;
const ENTITY_TYPE = process.env.ENTITY_TYPE || 'Record';
const REGION = process.env.AWS_REGION || 'eu-west-1';

async function oauthBearerTokenProvider() {
  const response = await generateAuthToken({ region: REGION });
  return { value: response.token };
}

const kafka = new Kafka({
  clientId: `${DOMAIN.toLowerCase()}-producer`,
  brokers: BOOTSTRAP_SERVERS.split(','),
  ssl: true,
  sasl: {
    mechanism: 'oauthbearer' as any,
    oauthBearerProvider: oauthBearerTokenProvider as any,
  },
});

// Domain-aware event type derivation — maps DDB records to canonical eventTypes
function deriveEventType(newImage: Record<string, any>, oldImage: Record<string, any> | null): string | null {
  const isNew = !oldImage || !oldImage.PK;
  const status = newImage.status;
  const pk = newImage.PK || '';
  const sk = newImage.SK || '';
  const prefix = pk.split('#')[0];

  // ─── Domain-specific overrides ───────────────────────────────────
  // ERP receipts (no status field → default would be RECEIPT_CREATED)
  if (prefix === 'RECEIPT') return 'MATERIAL_RECEIVED';

  // ERP procurement long-form names (default PR_/INV_ are too terse).
  // PO_ISSUED/PO_CONFIRMED derive correctly from the default and are kept as-is.
  if (prefix === 'PR') return `PURCHASE_REQUISITION_${status || 'CREATED'}`.toUpperCase();
  if (prefix === 'INV') {
    if (status === 'RECEIVED') return 'SUPPLIER_INVOICE_RECEIVED';
    if (status === 'MATCHED') return 'INVOICE_MATCHED';
    if (status === 'BLOCKED') return 'INVOICE_BLOCKED';
    return `SUPPLIER_INVOICE_${status || 'RECEIVED'}`.toUpperCase();
  }

  // PLM engineering-change long-form names. ECO_*/BOM_REVISED derive correctly
  // from the default (ECO_INITIATED/IN_WORK/APPROVED/RELEASED, BOM_REVISED) — kept.
  if (prefix === 'ECR') return `CHANGE_REQUEST_${status || 'SUBMITTED'}`.toUpperCase();
  if (prefix === 'ECN') return 'CHANGE_NOTICE_ISSUED';

  // WMS kit events
  if (prefix === 'KIT') {
    if (status === 'SHORT') return 'KIT_SHORTAGE_DETECTED';
    if (status === 'STAGED') return 'KIT_STAGED';
    return `KIT_${status || 'CREATED'}`.toUpperCase();
  }

  // DHR records (all under SN# PK — distinguish by SK prefix)
  if (prefix === 'SN') {
    if (sk.startsWith('CERT#')) return 'CERT_LINKED';
    if (sk.startsWith('TEST#')) return 'TEST_RECORDED';
    if (sk.startsWith('OP#') && status === 'SIGNED') return 'OPERATION_SIGNED';
    return null; // skip unknown SN sub-records
  }

  // Program records (milestones vs EV metrics — distinguish by SK)
  if (prefix === 'PROGRAM') {
    if (sk.startsWith('MILESTONE#')) {
      const confidence = typeof newImage.confidence === 'number' ? newImage.confidence : parseInt(newImage.confidence);
      return confidence < 70 ? 'MILESTONE_AT_RISK' : 'MILESTONE_UPDATED';
    }
    if (sk.startsWith('EV#')) return 'EV_UPDATED';
    return null;
  }

  // SRM supplier scores (always score update regardless of qualificationStatus)
  if (prefix === 'SUPPLIER') return 'SUPPLIER_SCORE_UPDATED';

  // ─── Default derivation ──────────────────────────────────────────
  if (isNew && status) return `${prefix}_${status}`.toUpperCase();
  if (status && oldImage?.status && status !== oldImage.status) return `${prefix}_${status}`.toUpperCase();
  if (isNew) return `${prefix}_CREATED`.toUpperCase();

  return null;
}

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

  const eventType = deriveEventType(newImage, oldImage);
  if (!eventType) return null;

  const eventId = randomUUID();
  // Extract entity ID from common fields or PK
  const entityId = newImage.poNumber || newImage.receiptId || newImage.kitId
    || newImage.requisitionId || newImage.invoiceId
    || newImage.ecrId || newImage.ecnId || newImage.bomId
    || newImage.supplierId || newImage.partNumber || newImage.drawingNumber
    || newImage.ecoId || newImage.serialNumber || newImage.programId
    || newImage.anomalyId || newImage.workOrderId || newImage.PK;

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
      userId: newImage.lastModifiedBy || newImage.createdBy || 'system',
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
  console.log(`${DOMAIN} producer: ${event.Records.length} DDB stream records received`);

  const messages = event.Records
    .map((record, i) => {
      const result = processRecord(record);
      if (!result) {
        const img = record.dynamodb?.NewImage;
        const pk = img?.PK?.S || '?';
        const sk = img?.SK?.S || '?';
        console.log(`  [${i}] SKIPPED: ${record.eventName} PK=${pk} SK=${sk}`);
      }
      return result;
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  if (messages.length === 0) {
    console.log(`${DOMAIN} producer: 0 events after filtering — skipping`);
    return;
  }

  try {
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
  } catch (err: any) {
    console.error(`${DOMAIN} producer MSK error: ${err.message}`);
    throw err; // Let Lambda retry
  }
};
