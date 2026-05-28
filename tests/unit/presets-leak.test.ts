// Isolated test file — vi.mock at module level replaces the real
// `GislClient` constructor so we can capture the `config` object passed
// to it from `_createInternal` (gisl.ts). This pins the
// `presetDefaults: _presetDefaults, ...transportConfig` destructure as
// load-bearing — without it, a regression that forgot to strip the
// slot would silently forward a `PresetDefaults` instance into the
// low-level transport config.
//
// Kept separate from presets.test.ts because vi.mock applies file-wide;
// the broader presets suite needs the real GislClient.

import { describe, expect, it, vi } from 'vitest';

const constructorCalls: Array<{ config: Record<string, unknown> }> = [];

vi.mock('../../src/client.js', async () => {
  return {
    GislClient: class {
      constructor(config: Record<string, unknown>) {
        constructorCalls.push({ config: { ...config } });
      }
    },
    DEFAULT_MULTIPART_FIRST_CHUNK_SIZE: 5 * 1024 * 1024,
  };
});

// Imports MUST come after vi.mock (vitest hoists vi.mock but explicit
// post-mock import order keeps intent obvious).
const { create } = await import('../../src/gisl.js');
const { presetDefaults } = await import('../../src/ergonomic/presets/index.js');
const { OptimizeFor } = await import('../../src/generated/sdk_spec/enums.js');

describe('_createInternal strips presetDefaults from the GislClient config', () => {
  it('a fresh create({ presetDefaults }) call does NOT forward the slot into transportConfig', async () => {
    constructorCalls.length = 0;
    await create({
      apiKey: 'k_test_dummy',
      baseUrl: 'https://example.invalid',
      presetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, { quality: 75 }),
    });

    expect(constructorCalls).toHaveLength(1);
    const { config } = constructorCalls[0];
    // The destructure in `_createInternal` must remove this key before
    // the spread into the GislClient config. If this assertion fails,
    // someone deleted the `presetDefaults: _presetDefaults` line from
    // the destructure tuple in gisl.ts:_createInternal.
    expect('presetDefaults' in config).toBe(false);
    expect(Object.keys(config)).not.toContain('presetDefaults');
    // Sanity — the OTHER named fields still flow through.
    expect(config.baseUrl).toBe('https://example.invalid');
    expect(config.apiKey).toBe('k_test_dummy');
  });

  it('create() without the slot still constructs cleanly', async () => {
    constructorCalls.length = 0;
    await create({
      apiKey: 'k_test_dummy',
      baseUrl: 'https://example.invalid',
    });
    expect(constructorCalls).toHaveLength(1);
    expect('presetDefaults' in constructorCalls[0].config).toBe(false);
  });

  it('extra transport config (timeout, multipartConcurrency) still flows through unchanged', async () => {
    constructorCalls.length = 0;
    await create({
      apiKey: 'k_test_dummy',
      baseUrl: 'https://example.invalid',
      timeout: 5_000,
      multipartConcurrency: 2,
      presetDefaults: presetDefaults().imageCompress(OptimizeFor.Quality),
    });
    expect(constructorCalls).toHaveLength(1);
    const { config } = constructorCalls[0];
    expect(config.timeout).toBe(5_000);
    expect(config.multipartConcurrency).toBe(2);
    expect('presetDefaults' in config).toBe(false);
  });
});
