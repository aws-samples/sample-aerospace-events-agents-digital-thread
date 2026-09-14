/**
 * Event normalizer — MSK → MSK ISA-95 normalization step for the "legacy" ERP/PLM
 * applications.
 *
 * The legacy ERP/PLM producers publish their NATIVE vendor vocabulary to the raw
 * topics (aerospace.erp.raw, aerospace.plm.raw). This Lambda consumes those, maps
 * the payload to the ISA-95:2018 canonical model (see isa95-mapping.ts), and
 * republishes to the canonical topics (aerospace.erp.events, aerospace.plm.events)
 * that the knowledge graph, the datalake, and the agents all consume — so all three
 * are ISA-95-compliant from one place.
 *
 * Read pattern mirrors msk-consumer (MSKEvent, base64 records keyed by topic);
 * write pattern mirrors generic-producer (kafkajs + MSK IAM SASL).
 */

import { MSKEvent } from 'aws-lambda';
import { Kafka } from 'kafkajs';
import { generateAuthToken } from 'aws-msk-iam-sasl-signer-js';
import { normalizeToIsa95 } from './isa95-mapping';

const BOOTSTRAP_SERVERS = process.env.BOOTSTRAP_SERVERS!;
const REGION = process.env.AWS_REGION || 'eu-west-1';

// raw topic → canonical topic. Only the two illustrated legacy domains.
const TOPIC_MAP: Record<string, string> = {
  'aerospace.erp.raw': 'aerospace.erp.events',
  'aerospace.plm.raw': 'aerospace.plm.events',
};

async function oauthBearerTokenProvider() {
  const response = await generateAuthToken({ region: REGION });
  return { value: response.token };
}

const kafka = new Kafka({
  clientId: 'event-normalizer',
  brokers: BOOTSTRAP_SERVERS.split(','),
  ssl: true,
  sasl: {
    mechanism: 'oauthbearer' as any,
    oauthBearerProvider: oauthBearerTokenProvider as any,
  },
});

interface OutMessage { topic: string; key: string; value: string; }

// Ensure the canonical topics exist before producing (MSK auto-create is off;
// the legacy producers used to create these, but now they only write raw topics).
let topicsEnsured = false;
async function ensureCanonicalTopics() {
  if (topicsEnsured) return;
  const admin = kafka.admin();
  await admin.connect();
  try {
    const existing = await admin.listTopics();
    const needed = Object.values(TOPIC_MAP).filter((t) => !existing.includes(t));
    if (needed.length > 0) {
      await admin.createTopics({
        topics: needed.map((topic) => ({ topic, numPartitions: 3, replicationFactor: 2 })),
      });
      console.log(`Created canonical topics: ${needed.join(', ')}`);
    }
    topicsEnsured = true;
  } finally {
    await admin.disconnect();
  }
}

export const handler = async (event: MSKEvent): Promise<void> => {
  const outbound: OutMessage[] = [];

  for (const [topicWithPartition, partitionRecords] of Object.entries(event.records)) {
    // MSKEvent keys look like "aerospace.erp.raw-0"; strip the trailing partition.
    const rawTopic = topicWithPartition.replace(/-\d+$/, '');
    const canonTopic = TOPIC_MAP[rawTopic];
    if (!canonTopic) {
      console.log(`No canonical mapping for ${rawTopic} — skipping ${partitionRecords.length} records`);
      continue;
    }

    for (const record of partitionRecords) {
      const value = Buffer.from(record.value, 'base64').toString('utf-8');
      try {
        const raw = JSON.parse(value);
        const canonical = normalizeToIsa95(raw);
        outbound.push({
          topic: canonTopic,
          key: canonical.entityId || canonical.eventId,
          value: JSON.stringify(canonical),
        });
        console.log(`normalized ${rawTopic} ${raw.eventType}:${raw.entityId} → ${canonTopic} (isaClass=${canonical.isaClass}, scope=${canonical.isaScope})`);
      } catch (err: any) {
        console.error(`normalize failed on ${rawTopic} offset ${record.offset}: ${err.message}`);
        // Do not drop silently — forward the raw value so the datalake/graph still see it.
        outbound.push({ topic: canonTopic, key: record.key || 'unknown', value });
      }
    }
  }

  if (outbound.length === 0) {
    console.log('normalizer: 0 messages to republish');
    return;
  }

  await ensureCanonicalTopics();
  const producer = kafka.producer();
  await producer.connect();
  try {
    // Group by canonical topic for a single send per topic.
    const byTopic = new Map<string, { key: string; value: string }[]>();
    for (const m of outbound) {
      const arr = byTopic.get(m.topic) || [];
      arr.push({ key: m.key, value: m.value });
      byTopic.set(m.topic, arr);
    }
    for (const [topic, messages] of byTopic.entries()) {
      await producer.send({ topic, messages });
      console.log(`republished ${messages.length} ISA-95 events → ${topic}`);
    }
  } finally {
    await producer.disconnect();
  }
};
