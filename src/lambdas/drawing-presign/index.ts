/**
 * Drawing presign Lambda — GET /drawings/presign?key=drawings/...
 * Returns a short-TTL presigned GET URL for a private PLM drawing PNG in the
 * datalake bucket. Keys are restricted to the `drawings/` prefix.
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const BUCKET = process.env.DATALAKE_BUCKET || '';
const PREFIX = 'drawings/';
const TTL_SECONDS = 300;

const s3 = new S3Client({});

// CORS: echo the request Origin only when it is on the ALLOWED_ORIGINS allowlist.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean);
function corsHeaders(event: any): Record<string, string> {
  const origin = event?.headers?.origin ?? event?.headers?.Origin;
  return origin && ALLOWED_ORIGINS.includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type,Authorization', Vary: 'Origin' }
    : {};
}

export const handler = async (event: any): Promise<any> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };

  try {
    const key = event.queryStringParameters?.key;
    if (!key) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing key parameter' }) };
    }
    if (!key.startsWith(PREFIX) || !/^[\w./-]+$/.test(key) || key.includes('..')) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `key must be a plain path under '${PREFIX}'` }) };
    }

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
      { expiresIn: TTL_SECONDS },
    );

    return { statusCode: 200, headers, body: JSON.stringify({ url }) };
  } catch (err: any) {
    console.error('Presign error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
