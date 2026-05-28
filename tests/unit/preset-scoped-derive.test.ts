import { describe, expect, it, vi } from 'vitest';

import {
  presetDefaults,
  PresetDefaults,
  OptimizeFor,
  ImageMode,
  ImageMetadataPolicy,
  ImageFormat,
  VideoCodec,
  AudioBitrate,
  PdfProfile,
} from '../../src/index.js';
import { create } from '../../src/gisl.js';
import { resolveCompressOptions } from '../../src/ergonomic/preset_resolver.js';

// ---------------------------------------------------------------------------
// Headline AC — scoped quality overrides parent, parent outputFormat preserved
// ---------------------------------------------------------------------------

describe('client.withPresetDefaults — headline acceptance criterion', () => {
  it('scoped quality overrides parent clientDefault; parent outputFormat still applies (merge-not-replace)', async () => {
    process.env.GISL_API_KEY = 'k_test';
    const parentDefaults = presetDefaults().imageCompress(OptimizeFor.Size, {
      quality: 75,
      outputFormat: ImageFormat.Webp,
    });
    const client = await create({ apiKey: 'k_test', presetDefaults: parentDefaults });
    const evening = client.withPresetDefaults(
      presetDefaults().imageCompress(OptimizeFor.Size, { quality: 92 }),
    );
    // Pin the surface-level callable shape — derived client is an
    // ErgonomicClient with the same factory methods.
    expect(typeof evening.compress).toBe('function');

    // Resolve the wire payload by calling the resolver directly with the
    // same shape the evening builder would build.
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetDefaults: parentDefaults,
      scopedPresetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, { quality: 92 }),
      explicitOptions: {},
    });

    // quality came from scoped (92, not parent's 75 and not sdk's 65)
    expect(wireOptions.quality).toBe(92);
    // outputFormat NOT in scoped → falls through to parent clientDefault (Webp)
    expect(wireOptions.output_format).toBe('webp');

    // Bucket attribution: scoped owns quality; clientDefault owns output_format.
    expect(resolvedOptions.sources.scopedDefault).toContain('quality');
    expect(resolvedOptions.sources.scopedDefault).not.toContain('output_format');
    expect(resolvedOptions.sources.clientDefault).toContain('output_format');
    expect(resolvedOptions.sources.clientDefault).not.toContain('quality');

    delete process.env.GISL_API_KEY;
  });

  it('parent client unaffected — original .compress() still emits parent quality', () => {
    const parentDefaults = presetDefaults().imageCompress(OptimizeFor.Size, {
      quality: 75,
      outputFormat: ImageFormat.Webp,
    });
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetDefaults: parentDefaults,
      // No scopedPresetDefaults — simulating the parent's path.
      explicitOptions: {},
    });
    expect(wireOptions.quality).toBe(75);
    expect(resolvedOptions.sources.clientDefault).toContain('quality');
    expect(resolvedOptions.sources.scopedDefault).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Identity preservation — same underlying low-level config
// ---------------------------------------------------------------------------

describe('client.withPresetDefaults — identity preservation', () => {
  it('derived client shares the same baseUrl/apiKey/timeout via the underlying GislClient', async () => {
    process.env.GISL_API_KEY = 'k_test';
    const client = await create({
      apiKey: 'explicit_key',
      baseUrl: 'https://example.invalid',
      timeout: 5_000,
    });
    const derived = client.withPresetDefaults(presetDefaults().imageCompress(OptimizeFor.Size));

    // Internal fields (set by GislClient ctor) are private but readable
    // via the same cast pattern existing tests use (gisl.test.ts).
    const parentInternals = client as unknown as { baseUrl: string; timeoutMs: number };
    const derivedInternals = derived as unknown as { baseUrl: string; timeoutMs: number };
    expect(derivedInternals.baseUrl).toBe(parentInternals.baseUrl);
    expect(derivedInternals.timeoutMs).toBe(parentInternals.timeoutMs);
    delete process.env.GISL_API_KEY;
  });

  it('does NOT re-resolve credentials during derive (no env / profile lookup)', async () => {
    // Spy on resolveApiKey — if the derive accidentally goes through
    // _createInternal, this fires.
    const credentials = await import('../../src/credentials.js');
    const spy = vi.spyOn(credentials, 'resolveApiKey');
    const client = await create({ apiKey: 'explicit_key' });
    spy.mockClear(); // ignore the create() call itself; only count derive activity
    const derived = client.withPresetDefaults(presetDefaults().imageCompress(OptimizeFor.Size));
    expect(derived).toBeDefined();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('derived client is a distinct Proxy from parent (immutability check)', async () => {
    const client = await create({ apiKey: 'k' });
    const derived = client.withPresetDefaults(presetDefaults().imageCompress(OptimizeFor.Size));
    expect(derived).not.toBe(client);
  });
});

// ---------------------------------------------------------------------------
// Chained derives
// ---------------------------------------------------------------------------

describe('client.withPresetDefaults — chained derives (a.withPresetDefaults(d1).withPresetDefaults(d2))', () => {
  it('d2 fields win where defined; d1 fills gaps; parent fills the rest', async () => {
    const client = await create({
      apiKey: 'k',
      presetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, {
        quality: 65,
        outputFormat: ImageFormat.Webp,
        metadata: ImageMetadataPolicy.All,
      }),
    });
    const d1 = presetDefaults().imageCompress(OptimizeFor.Size, { quality: 80 });
    const d2 = presetDefaults().imageCompress(OptimizeFor.Size, { metadata: ImageMetadataPolicy.None });
    const chained = client.withPresetDefaults(d1).withPresetDefaults(d2);
    expect(chained).toBeDefined();
    // Resolve via the resolver directly (same scoped state the chained client carries).
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, {
        quality: 65,
        outputFormat: ImageFormat.Webp,
        metadata: ImageMetadataPolicy.All,
      }),
      scopedPresetDefaults: PresetDefaults.merge(d1, d2),
      explicitOptions: {},
    });
    // metadata: d2 wins (None, not d1-untouched, not parent's All)
    expect(wireOptions.metadata).toBe('none');
    // quality: d1 wins (80, not parent's 65), d2 didn't set it
    expect(wireOptions.quality).toBe(80);
    // outputFormat: parent's clientDefault still wins (Webp), scoped didn't set
    expect(wireOptions.output_format).toBe('webp');
    expect(resolvedOptions.sources.scopedDefault).toContain('metadata');
    expect(resolvedOptions.sources.scopedDefault).toContain('quality');
    expect(resolvedOptions.sources.clientDefault).toContain('output_format');
  });

  it('intermediate derive (after .withPresetDefaults(d1)) is unaffected by later .withPresetDefaults(d2)', async () => {
    const client = await create({
      apiKey: 'k',
      presetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, { quality: 65 }),
    });
    const d1 = presetDefaults().imageCompress(OptimizeFor.Size, { quality: 80 });
    const d2 = presetDefaults().imageCompress(OptimizeFor.Size, { quality: 92 });
    const intermediate = client.withPresetDefaults(d1);
    const final = intermediate.withPresetDefaults(d2);
    expect(intermediate).not.toBe(final);
    // The intermediate's scoped is still just d1 — not yet d2'd.
    const intermediateResolved = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, { quality: 65 }),
      scopedPresetDefaults: d1,
      explicitOptions: {},
    });
    expect(intermediateResolved.wireOptions.quality).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// PresetDefaults.merge static — direct semantics
// ---------------------------------------------------------------------------

describe('PresetDefaults.merge (static)', () => {
  it('two empty PresetDefaults merge to empty', () => {
    const merged = PresetDefaults.merge(presetDefaults(), presetDefaults());
    expect(merged).toBeInstanceOf(PresetDefaults);
    expect(merged.cellFor('image', 'compress', OptimizeFor.Size)).toBeUndefined();
  });

  it('child-only cell preserved verbatim (parent empty)', () => {
    const merged = PresetDefaults.merge(
      presetDefaults(),
      presetDefaults().imageCompress(OptimizeFor.Size, { quality: 80 }),
    );
    const cell = merged.cellFor('image', 'compress', OptimizeFor.Size);
    expect(cell?.quality).toBe(80);
  });

  it('parent-only cell preserved verbatim (child empty)', () => {
    const merged = PresetDefaults.merge(
      presetDefaults().imageCompress(OptimizeFor.Size, { quality: 70 }),
      presetDefaults(),
    );
    const cell = merged.cellFor('image', 'compress', OptimizeFor.Size);
    expect(cell?.quality).toBe(70);
  });

  it('both have same (cellKey, level) — child fields override, parent fills gaps', () => {
    const parent = presetDefaults().imageCompress(OptimizeFor.Size, {
      quality: 70,
      outputFormat: ImageFormat.Webp,
      metadata: ImageMetadataPolicy.All,
    });
    const child = presetDefaults().imageCompress(OptimizeFor.Size, {
      quality: 90,
      // outputFormat NOT set — should fall through to parent
    });
    const merged = PresetDefaults.merge(parent, child);
    const cell = merged.cellFor('image', 'compress', OptimizeFor.Size);
    expect(cell?.quality).toBe(90); // child wins
    expect(cell?.outputFormat).toBe(ImageFormat.Webp); // parent fills gap
    expect(cell?.metadata).toBe(ImageMetadataPolicy.All); // parent fills gap
  });

  it('different levels in parent and child kept as separate entries', () => {
    const parent = presetDefaults().imageCompress(OptimizeFor.Size, { quality: 65 });
    const child = presetDefaults().imageCompress(OptimizeFor.Quality, { quality: 92 });
    const merged = PresetDefaults.merge(parent, child);
    expect(merged.cellFor('image', 'compress', OptimizeFor.Size)?.quality).toBe(65);
    expect(merged.cellFor('image', 'compress', OptimizeFor.Quality)?.quality).toBe(92);
  });

  it('different cellKeys kept as separate entries', () => {
    const parent = presetDefaults().imageCompress(OptimizeFor.Size, { quality: 70 });
    const child = presetDefaults().videoCompress(OptimizeFor.Size, {
      codec: VideoCodec.H264,
      crf: 22,
    });
    const merged = PresetDefaults.merge(parent, child);
    expect(merged.cellFor('image', 'compress', OptimizeFor.Size)?.quality).toBe(70);
    expect(merged.cellFor('video', 'compress', OptimizeFor.Size)?.codec).toBe(VideoCodec.H264);
  });

  it('parent + child are untouched after merge (immutability)', () => {
    const parent = presetDefaults().imageCompress(OptimizeFor.Size, { quality: 70 });
    const child = presetDefaults().imageCompress(OptimizeFor.Size, { quality: 90 });
    const merged = PresetDefaults.merge(parent, child);
    expect(merged.cellFor('image', 'compress', OptimizeFor.Size)?.quality).toBe(90);
    expect(parent.cellFor('image', 'compress', OptimizeFor.Size)?.quality).toBe(70);
    expect(child.cellFor('image', 'compress', OptimizeFor.Size)?.quality).toBe(90);
  });

  it('merge frozen — returned PresetDefaults rejects mutation', () => {
    const merged = PresetDefaults.merge(
      presetDefaults(),
      presetDefaults().imageCompress(OptimizeFor.Size, { quality: 80 }),
    );
    expect(Object.isFrozen(merged)).toBe(true);
  });

  it('merges across all 7 cell types correctly', () => {
    const parent = presetDefaults()
      .imageCompress(OptimizeFor.Size, { quality: 70 })
      .audioCompress(OptimizeFor.Size, { bitrate: AudioBitrate._128 })
      .videoCompress(OptimizeFor.Size, { codec: VideoCodec.H264 })
      .pdfCompress(OptimizeFor.Size, { profile: PdfProfile.Web })
      .officeCompress(OptimizeFor.Size, { imageQuality: 75 })
      .odfCompress(OptimizeFor.Size, { imageQuality: 75 })
      .epubCompress(OptimizeFor.Size, { imageQuality: 75 });
    const child = presetDefaults()
      .imageCompress(OptimizeFor.Size, { quality: 90 })
      .audioCompress(OptimizeFor.Size, { bitrate: AudioBitrate._320 });
    const merged = PresetDefaults.merge(parent, child);
    // Overlapping cells: child wins
    expect(merged.cellFor('image', 'compress', OptimizeFor.Size)?.quality).toBe(90);
    expect(merged.cellFor('audio', 'compress', OptimizeFor.Size)?.bitrate).toBe(AudioBitrate._320);
    // Non-overlapping cells: parent verbatim
    expect(merged.cellFor('video', 'compress', OptimizeFor.Size)?.codec).toBe(VideoCodec.H264);
    expect(merged.cellFor('document_pdf', 'compress', OptimizeFor.Size)?.profile).toBe(PdfProfile.Web);
    expect(merged.cellFor('document_office', 'compress', OptimizeFor.Size)?.imageQuality).toBe(75);
    expect(merged.cellFor('document_odf', 'compress', OptimizeFor.Size)?.imageQuality).toBe(75);
    expect(merged.cellFor('document_epub', 'compress', OptimizeFor.Size)?.imageQuality).toBe(75);
  });
});

// ---------------------------------------------------------------------------
// Resolver layer-3 wiring (the scopedDefault arm)
// ---------------------------------------------------------------------------

describe('resolveCompressOptions — layer 3 (scopedDefault) — wired by T4c', () => {
  it('scoped contributes a field NOT in clientDefault → wire has it, sources.scopedDefault tracks it', () => {
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      // No clientDefault — only SDK shipped + scoped
      scopedPresetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, { quality: 100 }),
      explicitOptions: {},
    });
    expect(wireOptions.quality).toBe(100);
    expect(resolvedOptions.sources.scopedDefault).toContain('quality');
    expect(resolvedOptions.sources.clientDefault).toEqual([]);
  });

  it('scoped beats clientDefault (precedence): same field, both set', () => {
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, { quality: 75 }),
      scopedPresetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, { quality: 92 }),
      explicitOptions: {},
    });
    expect(wireOptions.quality).toBe(92);
    expect(resolvedOptions.sources.scopedDefault).toContain('quality');
    expect(resolvedOptions.sources.clientDefault).not.toContain('quality');
  });

  it('callPresetOverride beats scoped (precedence)', () => {
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      scopedPresetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, { quality: 92 }),
      presetOverrides: { quality: 60 },
      explicitOptions: {},
    });
    expect(wireOptions.quality).toBe(60);
    expect(resolvedOptions.sources.callPresetOverride).toContain('quality');
    expect(resolvedOptions.sources.scopedDefault).not.toContain('quality');
  });

  it('explicit beats scoped (precedence)', () => {
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      scopedPresetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, { quality: 92 }),
      explicitOptions: { quality: 50 },
    });
    expect(wireOptions.quality).toBe(50);
    expect(resolvedOptions.sources.explicit).toContain('quality');
  });

  it('no-optimize: scopedDefault contributes NOTHING even if a cell is registered', () => {
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      // No optimize.
      scopedPresetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, { quality: 92 }),
      explicitOptions: {},
    });
    expect('quality' in wireOptions).toBe(false);
    expect(resolvedOptions.sources.scopedDefault).toEqual([]);
  });

  it('scoped registered at one level — different level lookup returns empty bucket', () => {
    const { resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Quality,
      scopedPresetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, { quality: 50 }),
      explicitOptions: {},
    });
    // Scoped registered at Size, caller asked for Quality → no contribution
    expect(resolvedOptions.sources.scopedDefault).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// targetSize source attribution — scoped arm (architect adjustment 1)
// ---------------------------------------------------------------------------

describe('resolveCompressOptions — targetSize attribution: scoped wins over client', () => {
  it('scoped-set targetSize derives wire fields with sources.scopedDefault attribution', () => {
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'video',
      op: 'compress',
      optimize: OptimizeFor.Size,
      // SDK Size cell has codec:H265, crf:30 etc. Override codec to H264 so the
      // targetSize+codec post-merge validation accepts it.
      scopedPresetDefaults: presetDefaults().videoCompress(OptimizeFor.Size, {
        codec: VideoCodec.H264,
        targetSize: '100MB',
      }),
      explicitOptions: {},
    });
    expect(wireOptions.target_size_bytes).toBe(100 * 1024 * 1024);
    expect(wireOptions.encoding_mode).toBe('target_size');
    expect(resolvedOptions.sources.scopedDefault).toContain('target_size_bytes');
    expect(resolvedOptions.sources.scopedDefault).toContain('encoding_mode');
    expect(resolvedOptions.sources.scopedDefault).toContain('codec');
  });

  it('scoped targetSize wins over clientDefault targetSize', () => {
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'video',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetDefaults: presetDefaults().videoCompress(OptimizeFor.Size, {
        codec: VideoCodec.H264,
        targetSize: '50MB',
      }),
      scopedPresetDefaults: presetDefaults().videoCompress(OptimizeFor.Size, {
        targetSize: '100MB',
      }),
      explicitOptions: {},
    });
    expect(wireOptions.target_size_bytes).toBe(100 * 1024 * 1024);
    expect(resolvedOptions.sources.scopedDefault).toContain('target_size_bytes');
  });
});

// ---------------------------------------------------------------------------
// presetConfigHash includes scopedDefault inputs
// ---------------------------------------------------------------------------

describe('resolveCompressOptions — presetConfigHash with scoped layer', () => {
  it('hash present when ONLY scoped participated (no clientDefault, no callPresetOverride)', () => {
    const { resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      scopedPresetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, { quality: 88 }),
      explicitOptions: {},
    });
    expect(resolvedOptions.presetConfigHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('hash differs: same parent, with vs without scoped derive', () => {
    const parent = presetDefaults().imageCompress(OptimizeFor.Size, { quality: 75 });
    const withoutScoped = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetDefaults: parent,
      explicitOptions: {},
    }).resolvedOptions.presetConfigHash;
    const withScoped = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetDefaults: parent,
      scopedPresetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, { quality: 88 }),
      explicitOptions: {},
    }).resolvedOptions.presetConfigHash;
    expect(withoutScoped).toMatch(/^sha256:/);
    expect(withScoped).toMatch(/^sha256:/);
    expect(withoutScoped).not.toBe(withScoped);
  });

  it('hash differs: chained derive vs single derive', () => {
    const parent = presetDefaults().imageCompress(OptimizeFor.Size, { quality: 65 });
    const d1 = presetDefaults().imageCompress(OptimizeFor.Size, { quality: 80 });
    const d2 = presetDefaults().imageCompress(OptimizeFor.Size, { quality: 92 });
    const singleHash = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetDefaults: parent,
      scopedPresetDefaults: d1,
      explicitOptions: {},
    }).resolvedOptions.presetConfigHash;
    const chainedHash = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetDefaults: parent,
      scopedPresetDefaults: PresetDefaults.merge(d1, d2),
      explicitOptions: {},
    }).resolvedOptions.presetConfigHash;
    expect(singleHash).not.toBe(chainedHash);
  });
});

// ---------------------------------------------------------------------------
// Validations still fire on the scoped layer
// ---------------------------------------------------------------------------

describe('resolveCompressOptions — validations operate post-merge across scoped', () => {
  it('scoped sets mode=Lossless + quality from parent clientDefault → missing_dependency thrown', () => {
    const parent = presetDefaults().imageCompress(OptimizeFor.Size, { quality: 80 });
    const scoped = presetDefaults().imageCompress(OptimizeFor.Size, { mode: ImageMode.Lossless });
    expect(() =>
      resolveCompressOptions({
        media: 'image',
        op: 'compress',
        optimize: OptimizeFor.Size,
        presetDefaults: parent,
        scopedPresetDefaults: scoped,
        explicitOptions: {},
      }),
    ).toThrow(/missing_dependency|quality.*Lossless/);
  });

  it('scoped targetSize + parent non-H264 codec → invalid_combination', () => {
    const parent = presetDefaults().videoCompress(OptimizeFor.Size, { codec: VideoCodec.H265 });
    const scoped = presetDefaults().videoCompress(OptimizeFor.Size, { targetSize: '50MB' });
    expect(() =>
      resolveCompressOptions({
        media: 'video',
        op: 'compress',
        optimize: OptimizeFor.Size,
        presetDefaults: parent,
        scopedPresetDefaults: scoped,
        explicitOptions: {},
      }),
    ).toThrow(/invalid_combination|targetSize/);
  });
});

// ---------------------------------------------------------------------------
// END-TO-END: Proxy → OperationBuilder → resolver → wire payload
// (test-reviewer CRITICAL gap #3 — without this, a broken Proxy or builder
// arg-threading would silently pass all the resolver-direct tests.)
// ---------------------------------------------------------------------------

describe('end-to-end: withPresetDefaults threads scoped layer all the way to createWorkflow', () => {
  it('derived client .compress(...).run() sends a workflow payload carrying the scoped-derived field', async () => {
    process.env.GISL_API_KEY = 'k_test';
    const { GislClient } = await import('../../src/client.js');

    // Capture every createWorkflow call so we can inspect the wire payload.
    const createWorkflowSpy = vi
      .spyOn(GislClient.prototype, 'createWorkflow')
      .mockResolvedValue({
        workflowId: 'wf_e2e',
        status: 'completed',
        jobs: [{ jobId: 'j', ref: 'op', status: 'completed' }],
      } as unknown as Awaited<ReturnType<typeof GislClient.prototype.createWorkflow>>);
    vi.spyOn(GislClient.prototype, 'uploadFile').mockResolvedValue({
      fileId: 'f1',
      contentType: 'image/jpeg',
      sizeBytes: 100,
    } as unknown as Awaited<ReturnType<typeof GislClient.prototype.uploadFile>>);
    vi.spyOn(GislClient.prototype, 'getWorkflowStatus').mockResolvedValue({
      workflowId: 'wf_e2e',
      status: 'completed',
      jobs: [{ jobId: 'j', ref: 'op', status: 'completed' }],
    } as unknown as Awaited<ReturnType<typeof GislClient.prototype.getWorkflowStatus>>);
    vi.spyOn(GislClient.prototype, 'getWorkflowDownloads').mockResolvedValue({
      downloads: [{ jobId: 'j', ref: 'op', files: [] }],
    } as unknown as Awaited<ReturnType<typeof GislClient.prototype.getWorkflowDownloads>>);

    const client = await create({
      apiKey: 'k_test',
      presetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, {
        quality: 75,
        outputFormat: ImageFormat.Webp,
      }),
    });
    const evening = client.withPresetDefaults(
      presetDefaults().imageCompress(OptimizeFor.Size, { quality: 92 }),
    );
    const result = await evening
      .compress('x.jpg', { optimize: OptimizeFor.Size })
      .run({ maxWait: '30s', useSSE: false });

    // The wire payload — argument to createWorkflow — must carry quality:92
    // (scoped wins) AND output_format:'webp' (parent's clientDefault fills).
    expect(createWorkflowSpy).toHaveBeenCalledTimes(1);
    const wirePayload = createWorkflowSpy.mock.calls[0][0] as {
      jobs: ReadonlyArray<{ operations: ReadonlyArray<{ options: Record<string, unknown> }> }>;
    };
    const op = wirePayload.jobs[0].operations[0];
    expect(op.options.quality).toBe(92);
    expect(op.options.output_format).toBe('webp');

    // resolvedOptions surfaced on Result mirrors the threading.
    expect(result.resolvedOptions.sources.scopedDefault).toContain('quality');
    expect(result.resolvedOptions.sources.clientDefault).toContain('output_format');
    expect(result.resolvedOptions.presetConfigHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    vi.restoreAllMocks();
    delete process.env.GISL_API_KEY;
  });

  it('parent client is unaffected on the wire — same scenario through the parent emits the parent payload', async () => {
    process.env.GISL_API_KEY = 'k_test';
    const { GislClient } = await import('../../src/client.js');

    const createWorkflowSpy = vi
      .spyOn(GislClient.prototype, 'createWorkflow')
      .mockResolvedValue({
        workflowId: 'wf_parent',
        status: 'completed',
        jobs: [{ jobId: 'j', ref: 'op', status: 'completed' }],
      } as unknown as Awaited<ReturnType<typeof GislClient.prototype.createWorkflow>>);
    vi.spyOn(GislClient.prototype, 'uploadFile').mockResolvedValue({
      fileId: 'f1',
      contentType: 'image/jpeg',
      sizeBytes: 100,
    } as unknown as Awaited<ReturnType<typeof GislClient.prototype.uploadFile>>);
    vi.spyOn(GislClient.prototype, 'getWorkflowStatus').mockResolvedValue({
      workflowId: 'wf_parent',
      status: 'completed',
      jobs: [{ jobId: 'j', ref: 'op', status: 'completed' }],
    } as unknown as Awaited<ReturnType<typeof GislClient.prototype.getWorkflowStatus>>);
    vi.spyOn(GislClient.prototype, 'getWorkflowDownloads').mockResolvedValue({
      downloads: [{ jobId: 'j', ref: 'op', files: [] }],
    } as unknown as Awaited<ReturnType<typeof GislClient.prototype.getWorkflowDownloads>>);

    const client = await create({
      apiKey: 'k_test',
      presetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, {
        quality: 75,
        outputFormat: ImageFormat.Webp,
      }),
    });
    // CONSTRUCT but don't use evening — proves the parent's wire isn't
    // contaminated even when a sibling derive exists.
    void client.withPresetDefaults(
      presetDefaults().imageCompress(OptimizeFor.Size, { quality: 92 }),
    );
    await client.compress('x.jpg', { optimize: OptimizeFor.Size }).run({ maxWait: '30s', useSSE: false });

    const wirePayload = createWorkflowSpy.mock.calls[0][0] as {
      jobs: ReadonlyArray<{ operations: ReadonlyArray<{ options: Record<string, unknown> }> }>;
    };
    const op = wirePayload.jobs[0].operations[0];
    expect(op.options.quality).toBe(75);
    expect(op.options.output_format).toBe('webp');

    vi.restoreAllMocks();
    delete process.env.GISL_API_KEY;
  });
});

// ---------------------------------------------------------------------------
// Concurrency — parent + derived clients in flight simultaneously
// (test-reviewer IMPORTANT gap #1 — pins the docblock claim)
// ---------------------------------------------------------------------------

describe('concurrency: parent + derived calls do not cross-contaminate', () => {
  it('Promise.all([parent.run(), derived.run()]) — each wire payload carries its own scoped state', async () => {
    process.env.GISL_API_KEY = 'k_test';
    const { GislClient } = await import('../../src/client.js');

    const createWorkflowSpy = vi
      .spyOn(GislClient.prototype, 'createWorkflow')
      .mockImplementation(async () => ({
        workflowId: 'wf_x',
        status: 'completed',
        jobs: [{ jobId: 'j', ref: 'op', status: 'completed' }],
      }) as unknown as Awaited<ReturnType<typeof GislClient.prototype.createWorkflow>>);
    vi.spyOn(GislClient.prototype, 'uploadFile').mockResolvedValue({
      fileId: 'f1',
      contentType: 'image/jpeg',
      sizeBytes: 100,
    } as unknown as Awaited<ReturnType<typeof GislClient.prototype.uploadFile>>);
    vi.spyOn(GislClient.prototype, 'getWorkflowStatus').mockResolvedValue({
      workflowId: 'wf_x',
      status: 'completed',
      jobs: [{ jobId: 'j', ref: 'op', status: 'completed' }],
    } as unknown as Awaited<ReturnType<typeof GislClient.prototype.getWorkflowStatus>>);
    vi.spyOn(GislClient.prototype, 'getWorkflowDownloads').mockResolvedValue({
      downloads: [{ jobId: 'j', ref: 'op', files: [] }],
    } as unknown as Awaited<ReturnType<typeof GislClient.prototype.getWorkflowDownloads>>);

    const client = await create({
      apiKey: 'k_test',
      presetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, { quality: 75 }),
    });
    const evening = client.withPresetDefaults(
      presetDefaults().imageCompress(OptimizeFor.Size, { quality: 92 }),
    );
    await Promise.all([
      client.compress('a.jpg', { optimize: OptimizeFor.Size }).run({ maxWait: '30s', useSSE: false }),
      evening.compress('b.jpg', { optimize: OptimizeFor.Size }).run({ maxWait: '30s', useSSE: false }),
      client.compress('c.jpg', { optimize: OptimizeFor.Size }).run({ maxWait: '30s', useSSE: false }),
      evening.compress('d.jpg', { optimize: OptimizeFor.Size }).run({ maxWait: '30s', useSSE: false }),
    ]);

    expect(createWorkflowSpy).toHaveBeenCalledTimes(4);
    const qualities = createWorkflowSpy.mock.calls.map(
      (c) =>
        (
          c[0] as {
            jobs: ReadonlyArray<{ operations: ReadonlyArray<{ options: Record<string, unknown> }> }>;
          }
        ).jobs[0].operations[0].options.quality,
    );
    // Two parent calls → 75; two derived calls → 92. Order preserved by
    // Promise.all per the spec.
    expect(qualities).toEqual([75, 92, 75, 92]);

    vi.restoreAllMocks();
    delete process.env.GISL_API_KEY;
  });
});

// ---------------------------------------------------------------------------
// Empty withPresetDefaults — no-op contract
// (test-reviewer IMPORTANT gap #4)
// ---------------------------------------------------------------------------

describe('client.withPresetDefaults(presetDefaults()) — empty derive', () => {
  it('returns a distinct client (immutability) but produces the same wire payload as the parent', async () => {
    process.env.GISL_API_KEY = 'k_test';
    const { GislClient } = await import('../../src/client.js');
    const createWorkflowSpy = vi
      .spyOn(GislClient.prototype, 'createWorkflow')
      .mockResolvedValue({
        workflowId: 'wf_empty',
        status: 'completed',
        jobs: [{ jobId: 'j', ref: 'op', status: 'completed' }],
      } as unknown as Awaited<ReturnType<typeof GislClient.prototype.createWorkflow>>);
    vi.spyOn(GislClient.prototype, 'uploadFile').mockResolvedValue({
      fileId: 'f1',
      contentType: 'image/jpeg',
      sizeBytes: 100,
    } as unknown as Awaited<ReturnType<typeof GislClient.prototype.uploadFile>>);
    vi.spyOn(GislClient.prototype, 'getWorkflowStatus').mockResolvedValue({
      workflowId: 'wf_empty',
      status: 'completed',
      jobs: [{ jobId: 'j', ref: 'op', status: 'completed' }],
    } as unknown as Awaited<ReturnType<typeof GislClient.prototype.getWorkflowStatus>>);
    vi.spyOn(GislClient.prototype, 'getWorkflowDownloads').mockResolvedValue({
      downloads: [{ jobId: 'j', ref: 'op', files: [] }],
    } as unknown as Awaited<ReturnType<typeof GislClient.prototype.getWorkflowDownloads>>);

    const client = await create({
      apiKey: 'k_test',
      presetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, { quality: 75 }),
    });
    const noOpDerived = client.withPresetDefaults(presetDefaults());
    expect(noOpDerived).not.toBe(client);
    const result = await noOpDerived
      .compress('x.jpg', { optimize: OptimizeFor.Size })
      .run({ maxWait: '30s', useSSE: false });

    const wirePayload = createWorkflowSpy.mock.calls[0][0] as {
      jobs: ReadonlyArray<{ operations: ReadonlyArray<{ options: Record<string, unknown> }> }>;
    };
    const op = wirePayload.jobs[0].operations[0];
    // Same wire as parent — quality:75 from clientDefault, no scoped contribution.
    expect(op.options.quality).toBe(75);
    // sources.scopedDefault is empty even though scopedPresetDefaults was supplied.
    expect(result.resolvedOptions.sources.scopedDefault).toEqual([]);

    vi.restoreAllMocks();
    delete process.env.GISL_API_KEY;
  });
});

// ---------------------------------------------------------------------------
// Chained Proxy resolution — same-field stack final-wins
// (test-reviewer IMPORTANT gap #5 — proves Proxy.withPresetDefaults stacking,
//  not just PresetDefaults.merge static)
// ---------------------------------------------------------------------------

describe('chained withPresetDefaults — same-field stack: final derive wins on the wire', () => {
  it('a.withPresetDefaults(d1{quality:80}).withPresetDefaults(d2{quality:92}) emits quality:92', async () => {
    process.env.GISL_API_KEY = 'k_test';
    const { GislClient } = await import('../../src/client.js');
    const createWorkflowSpy = vi
      .spyOn(GislClient.prototype, 'createWorkflow')
      .mockResolvedValue({
        workflowId: 'wf_chain',
        status: 'completed',
        jobs: [{ jobId: 'j', ref: 'op', status: 'completed' }],
      } as unknown as Awaited<ReturnType<typeof GislClient.prototype.createWorkflow>>);
    vi.spyOn(GislClient.prototype, 'uploadFile').mockResolvedValue({
      fileId: 'f1',
      contentType: 'image/jpeg',
      sizeBytes: 100,
    } as unknown as Awaited<ReturnType<typeof GislClient.prototype.uploadFile>>);
    vi.spyOn(GislClient.prototype, 'getWorkflowStatus').mockResolvedValue({
      workflowId: 'wf_chain',
      status: 'completed',
      jobs: [{ jobId: 'j', ref: 'op', status: 'completed' }],
    } as unknown as Awaited<ReturnType<typeof GislClient.prototype.getWorkflowStatus>>);
    vi.spyOn(GislClient.prototype, 'getWorkflowDownloads').mockResolvedValue({
      downloads: [{ jobId: 'j', ref: 'op', files: [] }],
    } as unknown as Awaited<ReturnType<typeof GislClient.prototype.getWorkflowDownloads>>);

    const client = await create({
      apiKey: 'k_test',
      presetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, { quality: 65 }),
    });
    const chained = client
      .withPresetDefaults(presetDefaults().imageCompress(OptimizeFor.Size, { quality: 80 }))
      .withPresetDefaults(presetDefaults().imageCompress(OptimizeFor.Size, { quality: 92 }));
    await chained.compress('x.jpg', { optimize: OptimizeFor.Size }).run({ maxWait: '30s', useSSE: false });

    const wirePayload = createWorkflowSpy.mock.calls[0][0] as {
      jobs: ReadonlyArray<{ operations: ReadonlyArray<{ options: Record<string, unknown> }> }>;
    };
    const op = wirePayload.jobs[0].operations[0];
    expect(op.options.quality).toBe(92); // final derive wins on the wire

    vi.restoreAllMocks();
    delete process.env.GISL_API_KEY;
  });
});

// ---------------------------------------------------------------------------
// MapEachBuilder child inheritance of scoped defaults
// (test-reviewer IMPORTANT gap #6 — pins the closure-inheritance claim)
// ---------------------------------------------------------------------------

describe('MapEachBuilder child closures inherit the derived client.scoped defaults', () => {
  it('chained .compress().mapEach(art => client.compress(art, { optimize })) child sees scoped fields', async () => {
    process.env.GISL_API_KEY = 'k_test';
    const { GislClient } = await import('../../src/client.js');
    const createWorkflowSpy = vi
      .spyOn(GislClient.prototype, 'createWorkflow')
      .mockResolvedValueOnce({
        workflowId: 'wf_parent',
        status: 'completed',
        jobs: [{ jobId: 'jp', ref: 'op', status: 'completed' }],
      } as unknown as Awaited<ReturnType<typeof GislClient.prototype.createWorkflow>>)
      .mockResolvedValueOnce({
        workflowId: 'wf_child',
        status: 'completed',
        jobs: [{ jobId: 'jc', ref: 'op', status: 'completed' }],
      } as unknown as Awaited<ReturnType<typeof GislClient.prototype.createWorkflow>>);
    vi.spyOn(GislClient.prototype, 'uploadFile').mockResolvedValue({
      fileId: 'f',
      contentType: 'image/jpeg',
      sizeBytes: 100,
    } as unknown as Awaited<ReturnType<typeof GislClient.prototype.uploadFile>>);
    vi.spyOn(GislClient.prototype, 'getWorkflowStatus').mockResolvedValue({
      workflowId: 'wf_parent',
      status: 'completed',
      jobs: [{ jobId: 'jp', ref: 'op', status: 'completed' }],
    } as unknown as Awaited<ReturnType<typeof GislClient.prototype.getWorkflowStatus>>);
    vi.spyOn(GislClient.prototype, 'getWorkflowDownloads').mockResolvedValue({
      downloads: [
        {
          jobId: 'jp',
          ref: 'op',
          files: [
            {
              operation: 'compress',
              operationId: 'opid_1',
              filename: 'art.jpg',
              sizeBytes: 50,
              downloadUrl: 'https://signed.example.com/art.jpg',
            },
          ],
        },
      ],
    } as unknown as Awaited<ReturnType<typeof GislClient.prototype.getWorkflowDownloads>>);

    const client = await create({ apiKey: 'k_test' });
    const derived = client.withPresetDefaults(
      presetDefaults().imageCompress(OptimizeFor.Size, { quality: 88 }),
    );
    // mapEach: child callback constructs another compress via the SAME
    // derived client. The Proxy closure must thread scoped defaults to
    // the child OperationBuilder.
    await derived
      .compress('parent.jpg', { optimize: OptimizeFor.Size })
      .mapEach((art) => derived.compress(art.url, { optimize: OptimizeFor.Size }))
      .run({ maxWait: '60s', useSSE: false });

    // Both createWorkflow calls (parent + child) must carry quality:88.
    expect(createWorkflowSpy).toHaveBeenCalledTimes(2);
    for (const call of createWorkflowSpy.mock.calls) {
      const payload = call[0] as {
        jobs: ReadonlyArray<{ operations: ReadonlyArray<{ options: Record<string, unknown> }> }>;
      };
      expect(payload.jobs[0].operations[0].options.quality).toBe(88);
    }

    vi.restoreAllMocks();
    delete process.env.GISL_API_KEY;
  });
});
