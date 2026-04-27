import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  uploadSource,
  jobOutputSource,
  externalImportSource,
  connectionSource,
  WORKFLOW_CREATE_PAYLOAD_KEYS,
  type WorkflowSourcePayload,
  type JobInputV2Payload,
  type JobDefinitionPayload,
  type WorkflowCreatePayload,
  type ExternalDestinationPayload,
} from '../../src/types.js';

// ---------------------------------------------------------------------------
// Source factories — wire-format snake_case, `type`-discriminated.
// ---------------------------------------------------------------------------

describe('uploadSource', () => {
  it('returns the wire-format upload variant with file_id', () => {
    expect(uploadSource('upl_abc')).toEqual({
      type: 'upload',
      file_id: 'upl_abc',
    });
  });

  it('produces exactly two own keys (no extra/undefined entries)', () => {
    const payload = uploadSource('upl_abc');
    expect(Object.keys(payload).sort()).toEqual(['file_id', 'type']);
  });

  it('returns a value assignable to UploadSourcePayload and WorkflowSourcePayload', () => {
    const payload = uploadSource('upl_abc');
    // Discriminator narrowing.
    if (payload.type === 'upload') {
      expectTypeOf(payload.file_id).toEqualTypeOf<string>();
    }
    const widened: WorkflowSourcePayload = payload;
    expect(widened.type).toBe('upload');
  });
});

describe('jobOutputSource', () => {
  it('omits the `operation` key entirely when not provided', () => {
    const payload = jobOutputSource('compressed');
    expect(payload).toEqual({ type: 'job_output', from: 'compressed' });
    // Crucial: the key must not be present (vs `operation: undefined`).
    expect('operation' in payload).toBe(false);
    expect(Object.keys(payload).sort()).toEqual(['from', 'type']);
  });

  it('includes the `operation` key when provided', () => {
    const payload = jobOutputSource('compressed', 'op_1');
    expect(payload).toEqual({
      type: 'job_output',
      from: 'compressed',
      operation: 'op_1',
    });
    expect(Object.keys(payload).sort()).toEqual(['from', 'operation', 'type']);
  });

  it('treats explicit undefined the same as omitted operation', () => {
    // jobOutputSource('x', undefined) is callable since the param is optional.
    const payload = jobOutputSource('compressed', undefined);
    expect('operation' in payload).toBe(false);
  });
});

describe('externalImportSource', () => {
  it('returns the wire-format external_import variant', () => {
    expect(externalImportSource('eit_xyz')).toEqual({
      type: 'external_import',
      external_source_id: 'eit_xyz',
    });
  });

  it('produces exactly two own keys', () => {
    const payload = externalImportSource('eit_xyz');
    expect(Object.keys(payload).sort()).toEqual([
      'external_source_id',
      'type',
    ]);
  });
});

describe('connectionSource', () => {
  it('returns the wire-format connection variant with required path', () => {
    expect(connectionSource('conn_1', '/photos/abc.jpg')).toEqual({
      type: 'connection',
      connection_id: 'conn_1',
      path: '/photos/abc.jpg',
    });
  });

  it('produces exactly three own keys', () => {
    const payload = connectionSource('conn_1', '/photos/abc.jpg');
    expect(Object.keys(payload).sort()).toEqual([
      'connection_id',
      'path',
      'type',
    ]);
  });
});

// ---------------------------------------------------------------------------
// JobInputV2 composition
// ---------------------------------------------------------------------------

describe('JobInputV2Payload composition', () => {
  it('supports the base + overlay role pattern (image_watermark)', () => {
    const inputs: JobInputV2Payload[] = [
      { source: uploadSource('upl_base'), role: 'base' },
      { source: uploadSource('upl_overlay'), role: 'overlay' },
    ];

    expect(inputs).toEqual([
      {
        source: { type: 'upload', file_id: 'upl_base' },
        role: 'base',
      },
      {
        source: { type: 'upload', file_id: 'upl_overlay' },
        role: 'overlay',
      },
    ]);
  });

  it('supports the base + transition_mask role pattern (custom_luma)', () => {
    const inputs: JobInputV2Payload[] = [
      { source: uploadSource('upl_clip'), role: 'base' },
      {
        source: uploadSource('upl_mask'),
        role: 'transition_mask',
      },
    ];

    expect(inputs[1].role).toBe('transition_mask');
    expect(inputs[1].source).toEqual({
      type: 'upload',
      file_id: 'upl_mask',
    });
  });

  it('round-trips per_input_options as a free-form record', () => {
    const input: JobInputV2Payload = {
      source: jobOutputSource('clip_a'),
      per_input_options: {
        transition: 'fade',
        duration_ms: 250,
      },
    };

    expect(input).toEqual({
      source: { type: 'job_output', from: 'clip_a' },
      per_input_options: { transition: 'fade', duration_ms: 250 },
    });
  });
});

// ---------------------------------------------------------------------------
// JobDefinition composition
// ---------------------------------------------------------------------------

describe('JobDefinitionPayload composition', () => {
  it('builds a single-input job via `source` (no `inputs` key)', () => {
    const job: JobDefinitionPayload = {
      source: uploadSource('upl_abc'),
      operations: [{ type: 'compress', options: { quality: 80 } }],
    };

    expect(job).toEqual({
      source: { type: 'upload', file_id: 'upl_abc' },
      operations: [{ type: 'compress', options: { quality: 80 } }],
    });
    expect('inputs' in job).toBe(false);
    expect('id' in job).toBe(false);
  });

  it('builds a multi-input job via `inputs` (no `source` key)', () => {
    const job: JobDefinitionPayload = {
      inputs: [
        { source: uploadSource('upl_a') },
        { source: uploadSource('upl_b') },
      ],
      operations: [{ type: 'merge', options: { format: 'pdf' } }],
    };

    expect(job).toEqual({
      inputs: [
        { source: { type: 'upload', file_id: 'upl_a' } },
        { source: { type: 'upload', file_id: 'upl_b' } },
      ],
      operations: [{ type: 'merge', options: { format: 'pdf' } }],
    });
    expect('source' in job).toBe(false);
  });

  it('preserves an explicit `id` for downstream references', () => {
    const job: JobDefinitionPayload = {
      id: 'compressed_job',
      source: uploadSource('upl_abc'),
      operations: [{ type: 'compress' }],
    };

    expect(job.id).toBe('compressed_job');
  });

  it('preserves the per-job `deliver` flag (hide-intermediates promotion)', () => {
    const job: JobDefinitionPayload = {
      id: 'thumbnail_job',
      source: jobOutputSource('compressed_job'),
      operations: [{ type: 'thumbnail' }],
      deliver: false,
    };

    expect(job.deliver).toBe(false);
    expect(job).toEqual({
      id: 'thumbnail_job',
      source: { type: 'job_output', from: 'compressed_job' },
      operations: [{ type: 'thumbnail' }],
      deliver: false,
    });
  });
});

// ---------------------------------------------------------------------------
// WorkflowCreatePayload top-level
// ---------------------------------------------------------------------------

describe('WorkflowCreatePayload top-level', () => {
  it('accepts a minimal payload with only `jobs`', () => {
    const payload: WorkflowCreatePayload = {
      jobs: [
        {
          source: uploadSource('upl_abc'),
          operations: [{ type: 'compress' }],
        },
      ],
    };

    expect(Object.keys(payload)).toEqual(['jobs']);
    expect(payload.jobs).toHaveLength(1);
  });

  it('accepts every top-level field together (full workflow)', () => {
    const payload: WorkflowCreatePayload = {
      jobs: [
        {
          id: 'job_1',
          source: uploadSource('upl_abc'),
          operations: [{ type: 'compress' }],
        },
        {
          id: 'job_2',
          source: jobOutputSource('job_1'),
          operations: [{ type: 'thumbnail' }],
        },
      ],
      workflow_edges: [{ from: 'job_1', to: 'job_2' }],
      callback_url: 'https://example.test/webhook',
      callback_events: ['workflow.completed'],
      export: {
        type: 'connection',
        connection_id: 'conn_1',
        path: '/exports/',
      },
      delivery: {
        mode: 'individual',
        selection: { type: 'terminal' },
      },
      processing: { class_hint: 'auto' },
    };

    // Sanity-check every key landed in place.
    expect(payload.workflow_edges).toEqual([{ from: 'job_1', to: 'job_2' }]);
    expect(payload.callback_url).toBe('https://example.test/webhook');
    expect(payload.callback_events).toEqual(['workflow.completed']);
    expect(payload.export?.type).toBe('connection');
    expect(payload.delivery?.mode).toBe('individual');
    expect(payload.processing?.class_hint).toBe('auto');
  });

  it('supports `export` as a connection ExternalDestination', () => {
    const dest: ExternalDestinationPayload = {
      type: 'connection',
      connection_id: 'conn_aws',
      path: '/exports/2026/',
    };
    const payload: WorkflowCreatePayload = {
      jobs: [
        {
          source: uploadSource('upl_a'),
          operations: [{ type: 'compress' }],
        },
      ],
      export: dest,
    };

    expect(payload.export).toEqual({
      type: 'connection',
      connection_id: 'conn_aws',
      path: '/exports/2026/',
    });
  });

  it('supports `export` as an external_import ExternalDestination', () => {
    const dest: ExternalDestinationPayload = {
      type: 'external_import',
      external_source_id: 'eit_dropbox_123',
    };
    const payload: WorkflowCreatePayload = {
      jobs: [
        {
          source: uploadSource('upl_a'),
          operations: [{ type: 'compress' }],
        },
      ],
      export: dest,
    };

    expect(payload.export).toEqual({
      type: 'external_import',
      external_source_id: 'eit_dropbox_123',
    });
  });

  it('round-trips a bundle delivery with all options set', () => {
    const payload: WorkflowCreatePayload = {
      jobs: [
        {
          source: uploadSource('upl_a'),
          operations: [{ type: 'compress' }],
        },
      ],
      delivery: {
        mode: 'bundle',
        bundle_format: 'zip',
        bundle_filename: 'output.zip',
        include_metadata: true,
      },
    };

    expect(payload.delivery).toEqual({
      mode: 'bundle',
      bundle_format: 'zip',
      bundle_filename: 'output.zip',
      include_metadata: true,
    });
  });

  it('round-trips processing.class_hint = long_form_preferred', () => {
    const payload: WorkflowCreatePayload = {
      jobs: [
        {
          source: uploadSource('upl_a'),
          operations: [{ type: 'compress' }],
        },
      ],
      processing: { class_hint: 'long_form_preferred' },
    };

    expect(payload.processing).toEqual({ class_hint: 'long_form_preferred' });
  });
});

// ---------------------------------------------------------------------------
// Drift-allow-list guard. The matching tsc invariant lives in src/types.ts so
// it actually compiles (tests are excluded from the build); this runtime check
// pins the wire-key tuple and order against accidental edits.
// ---------------------------------------------------------------------------

describe('WORKFLOW_CREATE_PAYLOAD_KEYS', () => {
  it('contains exactly the documented v2 top-level wire keys, in order', () => {
    expect([...WORKFLOW_CREATE_PAYLOAD_KEYS]).toEqual([
      'jobs',
      'workflow_edges',
      'callback_url',
      'callback_events',
      'export',
      'delivery',
      'processing',
    ]);
  });
});


// ---------------------------------------------------------------------------
// Coverage hardening (per test-reviewer findings)
// ---------------------------------------------------------------------------

describe('DeliveryPayload.selection coverage', () => {
  it('round-trips selection={type:"explicit", refs:[...]} with optional operation', () => {
    const payload: WorkflowCreatePayload = {
      jobs: [{ source: uploadSource('upl'), operations: [] }],
      delivery: {
        mode: 'individual',
        selection: {
          type: 'explicit',
          refs: [
            { ref: 'job_compress' },
            { ref: 'job_convert', operation: 'op_a' },
          ],
        },
      },
    };
    expect(payload.delivery?.selection).toEqual({
      type: 'explicit',
      refs: [
        { ref: 'job_compress' },
        { ref: 'job_convert', operation: 'op_a' },
      ],
    });
  });

  it('accepts selection={type:"all_outputs"}', () => {
    const payload: WorkflowCreatePayload = {
      jobs: [{ source: uploadSource('upl'), operations: [] }],
      delivery: { selection: { type: 'all_outputs' } },
    };
    expect(payload.delivery?.selection).toEqual({ type: 'all_outputs' });
  });
});

describe('WorkflowProcessingPayload.class_hint coverage', () => {
  it.each(['auto', 'short_form_only', 'long_form_allowed', 'long_form_preferred'] as const)(
    'accepts class_hint=%s',
    (classHint) => {
      const payload: WorkflowCreatePayload = {
        jobs: [{ source: uploadSource('upl'), operations: [] }],
        processing: { class_hint: classHint },
      };
      expect(payload.processing?.class_hint).toBe(classHint);
    },
  );
});

describe('JobDefinitionPayload XOR permissiveness', () => {
  it('type-permits both source and inputs[] simultaneously (server enforces XOR)', () => {
    // This test pins the deliberate type-permissive shape: TS does NOT
    // enforce source-XOR-inputs at the type level. Server-side validation
    // rejects payloads that supply both. This documents the choice so a
    // future refactor toward a discriminated union surfaces as a test
    // failure rather than a silent breaking change for existing callers.
    const job: JobDefinitionPayload = {
      source: uploadSource('upl'),
      inputs: [{ source: uploadSource('upl_2') }],
      operations: [],
    };
    expect(job.source).toBeDefined();
    expect(job.inputs).toHaveLength(1);
  });
});
