import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhook } from '../../src/webhook.js';
import { GislError } from '../../src/errors.js';

function sign(secret: string, body: string): string {
  const hex = createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${hex}`;
}

describe('verifyWebhook', () => {
  const secret = 'test-secret-key';
  const body = JSON.stringify({ event_type: 'workflow.completed', delivery_id: '123' });

  it('returns true for a valid signature', () => {
    const signature = sign(secret, body);
    expect(verifyWebhook(secret, signature, body)).toBe(true);
  });

  it('throws for a mismatched signature', () => {
    const badSignature = sign('wrong-secret', body);
    expect(() => verifyWebhook(secret, badSignature, body)).toThrow(GislError);
    expect(() => verifyWebhook(secret, badSignature, body)).toThrow(
      'Webhook signature verification failed',
    );
  });

  it('throws for a signature missing the sha256= prefix', () => {
    const hex = createHmac('sha256', secret).update(body).digest('hex');
    expect(() => verifyWebhook(secret, hex, body)).toThrow(GislError);
    expect(() => verifyWebhook(secret, hex, body)).toThrow('Invalid signature format');
  });

  it('works with Buffer body', () => {
    const bufBody = Buffer.from(body);
    const signature = sign(secret, body);
    expect(verifyWebhook(secret, signature, bufBody)).toBe(true);
  });

  it('throws for non-hex characters in signature', () => {
    const fakeHex = 'sha256=' + 'zz'.repeat(32);
    expect(() => verifyWebhook(secret, fakeHex, body)).toThrow(
      'Webhook signature verification failed',
    );
  });

  it('throws for truncated hex in signature', () => {
    const shortHex = 'sha256=' + 'ab'.repeat(16);
    expect(() => verifyWebhook(secret, shortHex, body)).toThrow(
      'Webhook signature verification failed',
    );
  });
});
