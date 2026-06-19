import { createHmac, timingSafeEqual } from 'node:crypto';
import { GislError } from './errors.js';
const SIGNATURE_PREFIX = 'sha256=';
/**
 * Verify a GISL webhook signature.
 *
 * @param secret   The `webhook_secret` from the workflow creation response.
 * @param signature The value of the `X-GIS-Signature` header.
 * @param body     The raw request body as a string or Buffer.
 * @returns `true` if valid.
 * @throws {GislError} if the signature is missing, malformed, or invalid.
 */
export function verifyWebhook(secret, signature, body) {
    if (!signature.startsWith(SIGNATURE_PREFIX)) {
        throw new GislError(`Invalid signature format: expected "${SIGNATURE_PREFIX}<hex>"`);
    }
    const receivedHex = signature.slice(SIGNATURE_PREFIX.length);
    if (!/^[0-9a-f]{64}$/i.test(receivedHex)) {
        throw new GislError('Webhook signature verification failed');
    }
    const expectedHex = createHmac('sha256', secret)
        .update(body)
        .digest('hex');
    const receivedBuf = Buffer.from(receivedHex, 'hex');
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    if (receivedBuf.length !== expectedBuf.length) {
        throw new GislError('Webhook signature verification failed');
    }
    if (!timingSafeEqual(receivedBuf, expectedBuf)) {
        throw new GislError('Webhook signature verification failed');
    }
    return true;
}
