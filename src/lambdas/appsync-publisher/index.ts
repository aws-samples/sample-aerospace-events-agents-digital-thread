/**
 * EventBridge → AppSync publisher Lambda.
 * Calls publishDashboardEvent mutation which triggers onDashboardEvent subscriptions.
 */

import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

const APPSYNC_URL = process.env.APPSYNC_ENDPOINT!;
const REGION = process.env.AWS_REGION || 'eu-west-1';

// Domain → channel mapping
const CHANNEL_MAP: Record<string, string> = {
  QMS: 'quality',
  MES: 'shop-floor',
  PLM: 'program',
  ERP: 'supply-chain',
  WMS: 'supply-chain',
  SRM: 'supply-chain',
  DHR: 'quality',
  SCADA: 'shop-floor',
  PROGRAM: 'program',
  INSERVICE: 'in-service',
};

const MUTATION = `
  mutation PublishDashboardEvent($input: PublishDashboardEventInput!) {
    publishDashboardEvent(input: $input) {
      eventId
      eventType
      domain
      entityId
      occurredAt
      channel
      payload
    }
  }
`;

export const handler = async (event: any): Promise<any> => {
  const canonicalEvent = event.detail?.value;
  if (!canonicalEvent) {
    console.log('No detail.value, skipping');
    return;
  }

  const domain = canonicalEvent.domain;
  const channel = CHANNEL_MAP[domain] ?? domain.toLowerCase();

  const input = {
    eventId: canonicalEvent.eventId,
    eventType: canonicalEvent.eventType,
    domain: canonicalEvent.domain,
    entityId: canonicalEvent.entityId,
    occurredAt: canonicalEvent.occurredAt,
    channel,
    payload: JSON.stringify(canonicalEvent.payload ?? {}),
  };

  const endpoint = new URL(APPSYNC_URL);
  const body = JSON.stringify({ query: MUTATION, variables: { input } });

  const request = new HttpRequest({
    method: 'POST',
    hostname: endpoint.hostname,
    path: endpoint.pathname,
    headers: {
      'Content-Type': 'application/json',
      host: endpoint.hostname,
    },
    body,
  });

  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region: REGION,
    service: 'appsync',
    sha256: Sha256,
  });

  const signed = await signer.sign(request);

  const response = await fetch(APPSYNC_URL, {
    method: 'POST',
    headers: signed.headers as Record<string, string>,
    body,
  });

  const result = await response.json();

  if (result.errors) {
    console.error('AppSync errors:', JSON.stringify(result.errors));
  } else {
    console.log(`Published ${canonicalEvent.eventType}:${canonicalEvent.entityId} → ${channel}`);
  }

  return result;
};
