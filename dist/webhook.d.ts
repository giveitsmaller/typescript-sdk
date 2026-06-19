/**
 * Verify a GISL webhook signature.
 *
 * @param secret   The `webhook_secret` from the workflow creation response.
 * @param signature The value of the `X-GIS-Signature` header.
 * @param body     The raw request body as a string or Buffer.
 * @returns `true` if valid.
 * @throws {GislError} if the signature is missing, malformed, or invalid.
 */
export declare function verifyWebhook(secret: string, signature: string, body: string | Buffer): boolean;
