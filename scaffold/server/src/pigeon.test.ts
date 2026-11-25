import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { canTransitionStatus, verifyPigeonSignature } from './pigeon.js';

function sign(secret: string, t: number, body: string): string {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex');
  return `t=${t},v1=${v1}`;
}

test('verifyPigeonSignature accepts valid recent signature', () => {
  const secret = 'test_secret';
  const body = JSON.stringify({ id: 'evt_1', type: 'message.inbound' });
  const now = Math.floor(Date.now() / 1000);
  const header = sign(secret, now - 30, body);
  assert.equal(verifyPigeonSignature(header, Buffer.from(body), secret), true);
});

test('verifyPigeonSignature rejects stale timestamp (>5 min)', () => {
  const secret = 'test_secret';
  const body = '{"ok":true}';
  const stale = Math.floor(Date.now() / 1000) - 305;
  const header = sign(secret, stale, body);
  assert.equal(verifyPigeonSignature(header, Buffer.from(body), secret), false);
});

test('verifyPigeonSignature rejects forged or tampered body', () => {
  const secret = 'test_secret';
  const body = '{"amount":100}';
  const now = Math.floor(Date.now() / 1000);
  const header = sign(secret, now, body);
  assert.equal(verifyPigeonSignature(header, Buffer.from('{"amount":999}'), secret), false);
  assert.equal(verifyPigeonSignature(undefined, Buffer.from(body), secret), false);
  assert.equal(verifyPigeonSignature('malformed', Buffer.from(body), secret), false);
});

test('canTransitionStatus enforces monotonic outbound lifecycle', () => {
  assert.equal(canTransitionStatus('queued', 'sending'), true);
  assert.equal(canTransitionStatus('sending', 'sent'), true);
  assert.equal(canTransitionStatus('sent', 'delivered'), true);
  assert.equal(canTransitionStatus('queued', 'delivered'), true);
  // Out-of-order: delivered arrived before sent -> must NOT regress
  assert.equal(canTransitionStatus('delivered', 'sent'), false);
  assert.equal(canTransitionStatus('failed', 'sent'), false);
  assert.equal(canTransitionStatus('delivered', 'failed'), false);
});
