import crypto from 'node:crypto';

/**
 * Verifies `t=<unix_sec>,v1=<hex_hmac_sha256>` webhook signatures against raw body bytes
 * and rejects timestamps older (or further ahead) than 5 minutes.
 */
export function verifyWebhookSignature(
  header: string | undefined,
  rawBody: Buffer,
  secret: string
): boolean {
  if (!header || typeof header !== 'string') return false;
  let tStr = '';
  let v1 = '';
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') tStr = v;
    else if (k === 'v1') v1 = v;
  }
  if (!tStr || !v1 || !/^\d+$/.test(tStr) || !/^[0-9a-f]+$/i.test(v1)) return false;

  const t = Number(tStr);
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - t) > 300) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${tStr}.`)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(v1.toLowerCase(), 'utf8');
  const b = Buffer.from(expected.toLowerCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
