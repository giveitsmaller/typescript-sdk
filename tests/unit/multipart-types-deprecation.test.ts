import { describe, it, expect } from 'vitest';
import type { GislClient } from '../../src/client.js';
import type {
  MultipartUploadState,
  MultipartPartListing,
  PresignedUrlPart,
  MultipartKeepaliveResponse,
  _Sdk3HandCodedMultipartStatusResult,
} from '../../src/index.js';

/**
 * iqR0V1mt, deprecation step (option b): the generated multipart models are
 * re-exported ALONGSIDE the deprecated `_Sdk3HandCoded*` shapes, and the
 * getUploadStatus() aggregate gets its stable name. These are compile-time
 * checks (enforced by `npm run check:tests`); the runtime assertion only keeps
 * vitest from reporting an empty test.
 */
describe('multipart resume types (iqR0V1mt deprecation step)', () => {
  it('getUploadStatus() returns MultipartUploadState, the same shape as the deprecated name', () => {
    type Returned = Awaited<ReturnType<GislClient['getUploadStatus']>>;
    const asStable = (r: Returned): MultipartUploadState => r;
    const asDeprecated = (s: MultipartUploadState): _Sdk3HandCodedMultipartStatusResult => s;
    expect([asStable, asDeprecated]).toHaveLength(2);
  });

  it('the generated models are importable from the SDK and carry Date timestamps', () => {
    const partDate = (p: MultipartPartListing): Date => p.lastModified;
    const presignDate = (p: PresignedUrlPart): Date => p.expiresAt;
    const keepaliveDate = (k: MultipartKeepaliveResponse): Date => k.manifestExpiresAt;
    expect([partDate, presignDate, keepaliveDate]).toHaveLength(3);
  });
});
