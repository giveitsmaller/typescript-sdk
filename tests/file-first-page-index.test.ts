import { describe, expect, it } from 'vitest';

import {
  RunResult,
  projectDownloadsToRunResult,
  projectMultiJobToRunResult,
} from '../src/file-first.js';
import type { OutputFile } from '../src/file-first.js';
import type { OperationDownload, WorkflowStatusResponse } from '@giveitsmaller/contracts/openapi';

/**
 * x1nYxBQx — a multi-output download (a PDF page of convert PDF->image or of
 * `split`, or one segment of an audio/video split) carries `page_index` or
 * `position` on its `/downloads` entry (ADR-0009 §D2). The projection lands
 * them on each {@link OutputFile} as `pageIndex` / `position`.
 *
 * Load-bearing invariants pinned here:
 *  1. **omit-when-absent:** an output without them keeps the pre-feature
 *     shape, with no `undefined`-valued key on the live object or in
 *     `toJSON()`, so existing JSON stays byte-identical.
 *  2. **`position: 0` is a value, not an absence:** the first segment's
 *     ordinal is 0 and must survive both projections.
 *  3. **field order:** the two keys come LAST, after `alreadyOptimalKind`.
 *
 * Download rows are cast through `unknown` so the test does not depend on the
 * locally-resolved contracts package carrying the fields.
 */

function download(o: {
  filename?: string;
  operation?: string;
  pageIndex?: number;
  position?: number;
  alreadyOptimal?: boolean;
  alreadyOptimalKind?: string;
}): OperationDownload {
  const filename = o.filename ?? 'page.png';
  return {
    operation: o.operation ?? 'split',
    operationId: 'op_x',
    filename,
    sizeBytes: 1024,
    downloadUrl: `https://cdn.example.com/${filename}`,
    ...(o.alreadyOptimal !== undefined ? { alreadyOptimal: o.alreadyOptimal } : {}),
    ...(o.alreadyOptimalKind !== undefined ? { alreadyOptimalKind: o.alreadyOptimalKind } : {}),
    ...(o.pageIndex !== undefined ? { pageIndex: o.pageIndex } : {}),
    ...(o.position !== undefined ? { position: o.position } : {}),
  } as unknown as OperationDownload;
}

function completedStatus(): WorkflowStatusResponse {
  return { status: 'completed', jobs: [] } as unknown as WorkflowStatusResponse;
}

describe('single-job projection — pageIndex / position', () => {
  const r = projectDownloadsToRunResult(
    'wf',
    completedStatus(),
    [
      {
        files: [
          download({ filename: 'p1.pdf', pageIndex: 1 }),
          download({ filename: 'p8.pdf', pageIndex: 8 }),
          download({ filename: 'seg0.mp3', position: 0 }),
          download({ filename: 'seg1.mp3', position: 1 }),
          download({ filename: 'plain.png', operation: 'compress' }),
        ],
      },
    ],
    null,
  );

  it('projects pageIndex onto the live OutputFile and toJSON', () => {
    expect(r.artifacts[0].pageIndex).toBe(1);
    expect(r.artifacts[1].pageIndex).toBe(8);
    expect('position' in r.artifacts[0]).toBe(false);
    expect(r.toJSON().artifacts[1]).toEqual({
      url: 'https://cdn.example.com/p8.pdf',
      filename: 'p8.pdf',
      sizeBytes: 1024,
      operation: 'split',
      pageIndex: 8,
    });
  });

  it('keeps position 0 on the live object and in toJSON', () => {
    expect(r.artifacts[2].position).toBe(0);
    expect('position' in r.artifacts[2]).toBe(true);
    expect('pageIndex' in r.artifacts[2]).toBe(false);
    expect(r.toJSON().artifacts[2].position).toBe(0);
    expect(Object.keys(r.toJSON().artifacts[2])).toEqual(['url', 'filename', 'sizeBytes', 'operation', 'position']);
    expect(r.artifacts[3].position).toBe(1);
  });

  it('omits both keys when absent, on the live object and in toJSON', () => {
    expect('pageIndex' in r.artifacts[4]).toBe(false);
    expect('position' in r.artifacts[4]).toBe(false);
    expect(Object.keys(r.artifacts[4])).toEqual(['url', 'filename', 'sizeBytes', 'operation']);
    expect(Object.keys(r.toJSON().artifacts[4])).toEqual(['url', 'filename', 'sizeBytes', 'operation']);
  });

  it('the per-input succeeded outputs carry the same projection', () => {
    expect(r.succeeded[0].outputs.map((o) => o.pageIndex)).toEqual([1, 8, undefined, undefined, undefined]);
    expect(r.succeeded[0].outputs.map((o) => o.position)).toEqual([undefined, undefined, 0, 1, undefined]);
  });
});

describe('multi-job (files fan-out) projection — pageIndex / position', () => {
  it('projects per job, keeps position 0, and leaves a bare job bare', () => {
    const status = {
      status: 'completed',
      jobs: [
        { ref: 'file-0', status: 'completed', operations: [] },
        { ref: 'file-1', status: 'completed', operations: [] },
      ],
    } as unknown as WorkflowStatusResponse;
    const r = projectMultiJobToRunResult(
      'wf',
      status,
      [
        { ref: 'file-0', files: [download({ filename: 'a-p3.png', pageIndex: 3 }), download({ filename: 'a-s0.mp4', position: 0 })] },
        { ref: 'file-1', files: [download({ filename: 'b.png', operation: 'compress' })] },
      ],
      new Map(),
    );

    expect(r.artifacts[0].pageIndex).toBe(3);
    expect(r.artifacts[1].position).toBe(0);
    expect(r.succeeded[0].outputs[0].pageIndex).toBe(3);
    expect(r.succeeded[0].outputs[1].position).toBe(0);
    expect('pageIndex' in r.artifacts[2]).toBe(false);
    expect('position' in r.artifacts[2]).toBe(false);
    expect(Object.keys(r.toJSON().succeeded[1].outputs[0])).toEqual(['url', 'filename', 'sizeBytes', 'operation']);
  });
});

describe('toJSON — re-projection', () => {
  it('emits pageIndex AFTER alreadyOptimalKind', () => {
    const r = projectDownloadsToRunResult(
      'wf',
      completedStatus(),
      [{ files: [download({ alreadyOptimal: true, alreadyOptimalKind: 'not_smaller', pageIndex: 2 })] }],
      null,
    );
    expect(Object.keys(r.toJSON().artifacts[0])).toEqual([
      'url',
      'filename',
      'sizeBytes',
      'operation',
      'alreadyOptimal',
      'alreadyOptimalKind',
      'pageIndex',
    ]);
  });

  it('carries the fields from a hand-built OutputFile, and position 0', () => {
    const paged: OutputFile = {
      url: 'https://cdn.example.com/a.png',
      filename: 'a.png',
      sizeBytes: 10,
      operation: 'convert',
      pageIndex: 4,
    };
    const segment: OutputFile = {
      url: 'https://cdn.example.com/s.mp3',
      filename: 's.mp3',
      sizeBytes: 10,
      operation: 'split',
      position: 0,
    };
    const json = new RunResult('wf', 'completed', [paged, segment], [], []).toJSON();
    expect(json.artifacts[0].pageIndex).toBe(4);
    expect('position' in json.artifacts[0]).toBe(false);
    expect(json.artifacts[1].position).toBe(0);
    expect('pageIndex' in json.artifacts[1]).toBe(false);
  });

  it('drops an extra property a structurally compatible input carries', () => {
    const extra = {
      url: 'https://cdn.example.com/a.png',
      filename: 'a.png',
      sizeBytes: 10,
      operation: 'convert',
      pageIndex: 1,
      secret: 'x',
    };
    const json = new RunResult('wf', 'completed', [extra], [], []).toJSON();
    expect(Object.keys(json.artifacts[0])).toEqual(['url', 'filename', 'sizeBytes', 'operation', 'pageIndex']);
  });
});
