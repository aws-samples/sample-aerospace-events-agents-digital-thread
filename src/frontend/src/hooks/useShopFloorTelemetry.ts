import { useState, useEffect, useRef } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { Sha256 } from '@aws-crypto/sha256-js';
import mqtt from 'mqtt';

const IOT_ENDPOINT = import.meta.env.VITE_IOT_ENDPOINT || '';
const REGION = import.meta.env.VITE_AWS_REGION || 'eu-west-1';
const IOT_POLICY_NAME = 'aerospace-browser-iot-policy';

export type TelemetryReading = {
  machineId: string;
  cellId: string;
  metric: string;
  value: number | string;
  unit?: string;
  threshold?: number;
  status?: string;
  timestamp: string;
};

export type MachineState = {
  machineId: string;
  cellId: string;
  oee?: number;
  status: string;
  lastVibration?: number;
  lastUpdate: string;
};

async function attachIoTPolicy(identityId: string, credentials: any) {
  const { IoTClient, AttachPolicyCommand } = await import('@aws-sdk/client-iot');
  const client = new IoTClient({
    region: REGION,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  });
  try {
    await client.send(new AttachPolicyCommand({
      policyName: IOT_POLICY_NAME,
      target: identityId,
    }));
    console.log('[MQTT] IoT policy attached to', identityId);
  } catch (err: any) {
    if (err.name !== 'ResourceAlreadyExistsException') {
      console.warn('[MQTT] IoT policy attach failed:', err.message);
    }
  }
}

// --- Manual SigV4 signing for IoT Core WebSocket ---

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

async function sha256Hex(data: string): Promise<string> {
  const hash = new Sha256();
  hash.update(data);
  const digest = await hash.digest();
  return toHex(digest);
}

async function getSigningKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(new TextEncoder().encode('AWS4' + secretKey), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

function rfc3986Encode(v: string): string {
  return encodeURIComponent(v).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

async function getSignedUrl(credentials: any): Promise<string> {
  const service = 'iotdevicegateway';
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDate = dateStamp + 'T' + now.toISOString().slice(11, 19).replace(/:/g, '') + 'Z';

  const credentialScope = `${dateStamp}/${REGION}/${service}/aws4_request`;

  // Build canonical querystring — Security-Token must NOT be in the signed portion
  const signedParams: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${credentials.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': '86400',
    'X-Amz-SignedHeaders': 'host',
  };

  const canonicalQuerystring = Object.keys(signedParams)
    .sort()
    .map(k => `${rfc3986Encode(k)}=${rfc3986Encode(signedParams[k])}`)
    .join('&');

  const canonicalRequest = [
    'GET',
    '/mqtt',
    canonicalQuerystring,
    `host:${IOT_ENDPOINT}\n`,
    'host',
    await sha256Hex(''),
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = await getSigningKey(credentials.secretAccessKey, dateStamp, REGION, service);
  const signatureBuffer = await hmacSha256(signingKey, stringToSign);
  const signature = toHex(signatureBuffer);

  // Token goes AFTER signature, not in the signed portion
  const tokenParam = credentials.sessionToken
    ? `&X-Amz-Security-Token=${rfc3986Encode(credentials.sessionToken)}`
    : '';

  return `wss://${IOT_ENDPOINT}/mqtt?${canonicalQuerystring}&X-Amz-Signature=${signature}${tokenParam}`;
}

const MAX_READINGS = 100;

export function useShopFloorTelemetry(topicFilter: string = 'aerospace/ares1/#') {
  const [machines, setMachines] = useState<Map<string, MachineState>>(new Map());
  const [readings, setReadings] = useState<TelemetryReading[]>([]);
  const [connected, setConnected] = useState(false);
  const clientRef = useRef<mqtt.MqttClient | null>(null);

  useEffect(() => {
    if (!IOT_ENDPOINT) {
      console.warn('[MQTT] IOT_ENDPOINT not configured');
      return;
    }

    let cancelled = false;

    async function connect() {
      try {
        const session = await fetchAuthSession();
        const creds = session.credentials;
        const identityId = session.identityId;
        if (!creds) throw new Error('No credentials');

        if (identityId) {
          await attachIoTPolicy(identityId, creds);
        }

        const url = await getSignedUrl(creds);
        console.log('[MQTT] Connecting to', IOT_ENDPOINT, '(manual SigV4)');

        const client = mqtt.connect('', {
          protocolVersion: 4,
          reconnectPeriod: 5000,
          connectTimeout: 10000,
          createWebsocket: () => new WebSocket(url, ['mqtt']),
        });

        client.on('connect', () => {
          if (!cancelled) setConnected(true);
          console.log('[MQTT] Connected, subscribing to', topicFilter);
          client.subscribe(topicFilter);
        });

        client.on('close', () => {
          if (!cancelled) setConnected(false);
        });

        client.on('error', (err) => {
          console.error('[MQTT] Error:', err.message || err);
        });

        client.on('message', (_topic: string, message: Buffer) => {
          if (cancelled) return;
          try {
            const payload = JSON.parse(message.toString()) as TelemetryReading;
            setReadings((prev) => [payload, ...prev].slice(0, MAX_READINGS));
            setMachines((prev) => {
              const next = new Map(prev);
              const existing = next.get(payload.machineId) ?? {
                machineId: payload.machineId,
                cellId: payload.cellId,
                status: 'UNKNOWN',
                lastUpdate: payload.timestamp,
              };
              if (payload.metric === 'oee_percent') existing.oee = payload.value as number;
              else if (payload.metric === 'status') existing.status = payload.value as string;
              else if (payload.metric === 'spindle_vibration_mm_s') existing.lastVibration = payload.value as number;
              existing.lastUpdate = payload.timestamp;
              next.set(payload.machineId, { ...existing });
              return next;
            });
          } catch { /* ignore */ }
        });

        clientRef.current = client;
      } catch (err) {
        console.error('[MQTT] Connection failed:', err);
      }
    }

    connect();

    return () => {
      cancelled = true;
      if (clientRef.current) {
        clientRef.current.end();
        clientRef.current = null;
      }
    };
  }, [topicFilter]);

  return { machines, readings, connected };
}
