import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, expectTypeOf } from 'vitest';
import type { GislClient } from '../../src/client.js';
import type {
  MultipartUploadState,
  MultipartPartListing,
  PresignedUrlPart,
  MultipartKeepaliveResponse,
  MultipartPresignResponse,
} from '../../src/index.js';

// aHgScsLJ — the five deprecated `_Sdk3HandCoded*` shapes are GONE from the
// public barrel. Each import below must fail to resolve; if one is re-exported,
// `npm run check:tests` reports an unused `@ts-expect-error`.
import type {
  // @ts-expect-error removed in aHgScsLJ
  _Sdk3HandCodedUploadedPart,
  // @ts-expect-error removed in aHgScsLJ
  _Sdk3HandCodedMultipartStatusResult,
  // @ts-expect-error removed in aHgScsLJ
  _Sdk3HandCodedPresignedPart,
  // @ts-expect-error removed in aHgScsLJ
  _Sdk3HandCodedPresignPartsResult,
  // @ts-expect-error removed in aHgScsLJ
  _Sdk3HandCodedKeepaliveResult,
} from '../../src/index.js';

const REMOVED_NAMES = [
  '_Sdk3HandCodedUploadedPart',
  '_Sdk3HandCodedMultipartStatusResult',
  '_Sdk3HandCodedPresignedPart',
  '_Sdk3HandCodedPresignPartsResult',
  '_Sdk3HandCodedKeepaliveResult',
] as const;

/**
 * iqR0V1mt step 2 (aHgScsLJ): the resume methods return the generated models
 * with `Date` timestamps and the hand-coded shapes are removed. The type
 * assertions are enforced by `npm run check:tests`; the snapshot assertion
 * ties the removal to the computed export surface (api-surface.test.ts diffs
 * that snapshot against the source barrel).
 */
describe('multipart resume types (aHgScsLJ post-removal guard)', () => {
  it('the removed names have no row in either public-surface snapshot', () => {
    const snapshotDir = join(__dirname, '..', 'api-surface');
    for (const file of ['index.txt', 'index.browser.txt']) {
      const names = readFileSync(join(snapshotDir, file), 'utf8')
        .split('\n')
        .map((line) => line.split('\t')[0]);
      // Positive control: the snapshot parse sees a name that IS exported.
      expect(names).toContain('MultipartUploadState');
      for (const removed of REMOVED_NAMES) {
        expect(names).not.toContain(removed);
      }
    }
  });

  it('getUploadStatus() returns MultipartUploadState with Date | null manifest and Date part timestamps', () => {
    type Returned = Awaited<ReturnType<GislClient['getUploadStatus']>>;
    expectTypeOf<Returned>().toEqualTypeOf<MultipartUploadState>();
    expectTypeOf<MultipartUploadState['manifestExpiresAt']>().toEqualTypeOf<Date | null>();
    expectTypeOf<
      MultipartUploadState['uploadedParts'][number]
    >().toEqualTypeOf<MultipartPartListing>();
    expectTypeOf<MultipartPartListing['lastModified']>().toEqualTypeOf<Date>();
  });

  it('presignParts() and keepaliveUpload() return the generated models with Date timestamps', () => {
    type Presign = Awaited<ReturnType<GislClient['presignParts']>>;
    type Keepalive = Awaited<ReturnType<GislClient['keepaliveUpload']>>;
    expectTypeOf<Presign>().toEqualTypeOf<MultipartPresignResponse>();
    expectTypeOf<Keepalive>().toEqualTypeOf<MultipartKeepaliveResponse>();
    expectTypeOf<PresignedUrlPart['expiresAt']>().toEqualTypeOf<Date>();
    expectTypeOf<MultipartKeepaliveResponse['manifestExpiresAt']>().toEqualTypeOf<Date>();
  });
});
