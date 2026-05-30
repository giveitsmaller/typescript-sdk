import { describe, it, expect } from 'vitest';
import {
  RunResult,
  type Downloader,
  type OutputFile,
  type ItemResult,
  type ItemFailure,
} from '../src/file-first.js';
import { GislNoSuchKeyError, GislSinkError } from '../src/errors.js';

/** Streaming downloader stub: records (url, dest) calls, writes nothing. */
class RecordingDownloader implements Downloader {
  calls: { url: string; dest: string }[] = [];
  async downloadTo(url: string, destPath: string): Promise<void> {
    this.calls.push({ url, dest: destPath });
  }
}

const out = (name: string): OutputFile => ({
  url: `https://cdn.example.com/${name}`,
  filename: name,
  sizeBytes: 10,
  operation: 'compress',
});

describe('RunResult', () => {
  it('sets url sugar for exactly one output', () => {
    const r = new RunResult('wf1', 'completed', [out('a.jpg')], [], []);
    expect(r.url).toBe('https://cdn.example.com/a.jpg');
  });

  it('leaves url undefined for zero or many outputs', () => {
    expect(new RunResult('wf1', 'completed', [], [], []).url).toBeUndefined();
    expect(new RunResult('wf1', 'completed', [out('a.jpg'), out('b.jpg')], [], []).url).toBeUndefined();
  });

  it('sets ok true only when failed is empty', () => {
    expect(new RunResult('wf1', 'completed', [], [], []).ok).toBe(true);
    const failed: ItemFailure[] = [{ key: 'bad', error: new Error('boom') }];
    expect(new RunResult('wf1', 'failed', [], [], failed).ok).toBe(false);
  });

  it('byKey returns the matching succeeded item', () => {
    const hero: ItemResult = { key: 'hero', outputs: [out('hero.jpg')] };
    const r = new RunResult('wf1', 'completed', [out('hero.jpg')], [hero], []);
    expect(r.byKey('hero')).toBe(hero);
  });

  it('byKey throws on a missing key', () => {
    const r = new RunResult('wf1', 'completed', [out('a.jpg')], [{ key: null, outputs: [out('a.jpg')] }], []);
    expect(() => r.byKey('nope')).toThrow(GislNoSuchKeyError);
  });

  it('toFile streams the single output', async () => {
    const dl = new RecordingDownloader();
    const r = new RunResult('wf1', 'completed', [out('a.jpg')], [], [], dl);
    await r.toFile('/tmp/out.jpg');
    expect(dl.calls).toEqual([{ url: 'https://cdn.example.com/a.jpg', dest: '/tmp/out.jpg' }]);
  });

  it('toFile throws not_single_output for zero or many', async () => {
    const dl = new RecordingDownloader();
    const r = new RunResult('wf1', 'completed', [], [], [], dl);
    await expect(r.toFile('/tmp/out.jpg')).rejects.toMatchObject({ reason: 'not_single_output' });
    expect(dl.calls).toEqual([]);
  });

  it('downloadTo writes each output in order', async () => {
    const dl = new RecordingDownloader();
    const r = new RunResult('wf1', 'completed', [out('a.jpg'), out('b.jpg')], [], [], dl);
    const manifest = await r.downloadTo('/tmp/out');
    expect(manifest.paths).toEqual(['/tmp/out/a.jpg', '/tmp/out/b.jpg']);
    expect(dl.calls).toHaveLength(2);
  });

  it('downloadTo failOnPartial throws when failures present and does not download', async () => {
    const dl = new RecordingDownloader();
    const failed: ItemFailure[] = [{ key: 'bad', error: new Error('boom') }];
    const r = new RunResult('wf1', 'partially_failed', [out('a.jpg')], [], failed, dl);
    await expect(r.downloadTo('/tmp/out', { failOnPartial: true })).rejects.toMatchObject({
      reason: 'partial_failure',
    });
    expect(dl.calls).toEqual([]);
  });

  it('downloadTo default downloads successes despite failures', async () => {
    const dl = new RecordingDownloader();
    const failed: ItemFailure[] = [{ key: 'bad', error: new Error('boom') }];
    const r = new RunResult('wf1', 'partially_failed', [out('a.jpg'), out('b.jpg')], [], failed, dl);
    const manifest = await r.downloadTo('/tmp/out'); // failOnPartial defaults false
    expect(manifest.paths).toHaveLength(2);
    expect(dl.calls).toHaveLength(2);
  });

  it('downloadTo does not double the separator on a trailing slash', async () => {
    const dl = new RecordingDownloader();
    const r = new RunResult('wf1', 'completed', [out('a.jpg')], [], [], dl);
    const manifest = await r.downloadTo('/tmp/out/');
    expect(manifest.paths).toEqual(['/tmp/out/a.jpg']);
  });

  it('downloadTo throws on a duplicate basename before writing', async () => {
    const dl = new RecordingDownloader();
    const a: OutputFile = { url: 'https://cdn.example.com/1', filename: 'a.jpg', sizeBytes: 1, operation: 'compress' };
    const b: OutputFile = { url: 'https://cdn.example.com/2', filename: 'sub/a.jpg', sizeBytes: 1, operation: 'compress' };
    const r = new RunResult('wf1', 'completed', [a, b], [], [], dl);
    await expect(r.downloadTo('/tmp/out')).rejects.toMatchObject({ reason: 'duplicate_filename' });
    expect(dl.calls).toEqual([]); // fails before any write
  });

  it('downloadTo throws on a case-insensitive basename collision', async () => {
    const dl = new RecordingDownloader();
    const a: OutputFile = { url: 'https://cdn.example.com/1', filename: 'a.jpg', sizeBytes: 1, operation: 'compress' };
    const b: OutputFile = { url: 'https://cdn.example.com/2', filename: 'A.JPG', sizeBytes: 1, operation: 'compress' };
    const r = new RunResult('wf1', 'completed', [a, b], [], [], dl);
    await expect(r.downloadTo('/tmp/out')).rejects.toMatchObject({ reason: 'duplicate_filename' });
    expect(dl.calls).toEqual([]);
  });

  it('downloadTo rejects an empty directory', async () => {
    const dl = new RecordingDownloader();
    const r = new RunResult('wf1', 'completed', [out('a.jpg')], [], [], dl);
    await expect(r.downloadTo('')).rejects.toMatchObject({ reason: 'invalid_directory' });
    expect(dl.calls).toEqual([]);
  });

  it('downloadTo strips path traversal from a server-supplied filename', async () => {
    const dl = new RecordingDownloader();
    const evil: OutputFile = {
      url: 'https://cdn.example.com/x',
      filename: '../../etc/passwd',
      sizeBytes: 1,
      operation: 'compress',
    };
    const r = new RunResult('wf1', 'completed', [evil], [], [], dl);
    const manifest = await r.downloadTo('/tmp/out');
    // The directory component is stripped — output stays in /tmp/out.
    expect(manifest.paths).toEqual(['/tmp/out/passwd']);
  });

  it('toFile throws downloader_unavailable when none bound', async () => {
    const r = new RunResult('wf1', 'completed', [out('a.jpg')], [], []);
    await expect(r.toFile('/tmp/out.jpg')).rejects.toMatchObject({ reason: 'downloader_unavailable' });
    await expect(r.toFile('/tmp/out.jpg')).rejects.toBeInstanceOf(GislSinkError);
  });

  it('downloadTo throws downloader_unavailable when none bound', async () => {
    const r = new RunResult('wf1', 'completed', [out('a.jpg')], [], []);
    await expect(r.downloadTo('/tmp/out')).rejects.toMatchObject({ reason: 'downloader_unavailable' });
  });

  it('byKey throws for a keyless run', () => {
    const r = new RunResult('wf1', 'completed', [out('a.jpg')], [{ key: null, outputs: [out('a.jpg')] }], []);
    expect(() => r.byKey('anything')).toThrow(GislNoSuchKeyError);
  });

  it('toJSON omits url for multi-output (undefined dropped by JSON.stringify)', () => {
    const r = new RunResult('wf1', 'completed', [out('a.jpg'), out('b.jpg')], [], []);
    expect(r.toJSON().url).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(JSON.parse(JSON.stringify(r)), 'url')).toBe(false);
    // Key order without `url` must still match PHP toArray() (url simply absent).
    expect(Object.keys(r.toJSON())).toEqual([
      'workflowId',
      'state',
      'ok',
      'artifacts',
      'succeeded',
      'failed',
    ]);
  });

  it('toJSON shape matches the cross-language golden', () => {
    const hero: ItemResult = { key: 'hero', outputs: [out('hero.jpg')] };
    const r = new RunResult('wf1', 'completed', [out('hero.jpg')], [hero], []);
    expect(r.toJSON()).toEqual({
      workflowId: 'wf1',
      state: 'completed',
      ok: true,
      url: 'https://cdn.example.com/hero.jpg',
      artifacts: [{ url: 'https://cdn.example.com/hero.jpg', filename: 'hero.jpg', sizeBytes: 10, operation: 'compress' }],
      succeeded: [
        { key: 'hero', outputs: [{ url: 'https://cdn.example.com/hero.jpg', filename: 'hero.jpg', sizeBytes: 10, operation: 'compress' }] },
      ],
      failed: [],
    });
    // Key ORDER must match PHP toArray() (workflowId, state, ok, url, artifacts,
    // succeeded, failed) — toEqual is order-insensitive, so assert the order of
    // the serialised JSON keys explicitly for cross-language parity.
    expect(Object.keys(r.toJSON())).toEqual([
      'workflowId',
      'state',
      'ok',
      'url',
      'artifacts',
      'succeeded',
      'failed',
    ]);
  });

  // NOTE: vitest toEqual is key-order-insensitive, so the PHP side
  // (assertSame, order-sensitive) is the guardian of toArray/toJSON field
  // order. A TS-only field-order regression is caught there, not here.
  it('toJSON shape with a failure matches the cross-language golden', () => {
    const ok: ItemResult = { key: 'good', outputs: [out('good.jpg')] };
    const failed: ItemFailure[] = [{ key: 'bad', error: new Error('boom') }];
    const r = new RunResult('wf1', 'partially_failed', [out('good.jpg')], [ok], failed);
    expect(r.toJSON()).toEqual({
      workflowId: 'wf1',
      state: 'partially_failed',
      ok: false,
      url: 'https://cdn.example.com/good.jpg',
      artifacts: [{ url: 'https://cdn.example.com/good.jpg', filename: 'good.jpg', sizeBytes: 10, operation: 'compress' }],
      succeeded: [
        { key: 'good', outputs: [{ url: 'https://cdn.example.com/good.jpg', filename: 'good.jpg', sizeBytes: 10, operation: 'compress' }] },
      ],
      failed: [{ key: 'bad', error: 'boom' }],
    });
  });
});
