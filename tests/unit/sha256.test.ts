/**
 * Direct anchors for the dependency-free pure-JS SHA-256 (NJNEoKLr). This is
 * the implementation behind the preset-resolver fingerprint; it replaced
 * `node:crypto` so the resolver stays out of the browser's Node-import graph.
 * The digests below are the canonical FIPS 180-4 vectors plus a multi-byte
 * UTF-8 case — they must match `node:crypto`'s
 * `createHash('sha256').update(input, 'utf8').digest('hex')` byte-for-byte, the
 * same property the preset-resolver exact-hash tests rely on.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256Hex } from '../../src/sha256.js';

describe('sha256Hex', () => {
  it('matches the canonical FIPS 180-4 vectors', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('hashes multi-byte UTF-8 input identically to node:crypto', () => {
    const inputs = [
      'café résumé 日本語 😀',
      '{"clientDefault":null,"scopedDefault":null,"callPresetOverride":{"quality":80}}',
      'x'.repeat(1000),
    ];
    for (const input of inputs) {
      const expected = createHash('sha256').update(input, 'utf8').digest('hex');
      expect(sha256Hex(input)).toBe(expected);
    }
  });

  it('returns a 64-char lowercase hex string', () => {
    const digest = sha256Hex('anything');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
