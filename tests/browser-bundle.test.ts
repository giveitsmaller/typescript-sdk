/**
 * Browser-bundle gate (NJNEoKLr). Structural protection that the browser entry
 * (`src/index.browser.ts`) does not statically pull any `node:` built-in into
 * its main chunk — otherwise a browser bundler (vite/webpack) errors or needs
 * node:fs externalization hacks, which is exactly what this ticket removes.
 *
 * It bundles the browser entry with esbuild (platform: 'browser'), applying the
 * same `node-fs.js -> node-fs.browser.js` swap the package.json `browser` field
 * declares (simulated here via a resolve plugin, since the gate bundles `src/`
 * directly rather than through the published `dist/` browser-field paths). It
 * then walks the metafile's STATIC (`import-statement`) edges from the entry.
 * Files reached only via dynamic `import()` (the Node downloader, the lazy
 * credentials fs) live in separate chunks and are intentionally excluded. If any
 * statically-reachable file carries a `node:` import, the test fails with the
 * offending edge — the same way a real browser build would break.
 *
 * A separate test pins the package.json `browser` field config so the simulated
 * swap matches what bundlers actually resolve.
 */
import { describe, it, expect } from 'vitest';
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '../src/index.browser.ts');
const nodeFsBrowser = resolve(here, '../src/node-fs.browser.ts');

// Mirror the package.json `browser` field's `node-fs.js -> node-fs.browser.js`
// remap. Browser bundlers apply that field to the published dist paths; because
// this gate bundles src/ directly we replicate it with a resolve plugin.
const browserFieldRemap: esbuild.Plugin = {
  name: 'browser-field-node-fs-remap',
  setup(build) {
    build.onResolve({ filter: /(^|\/)node-fs\.js$/ }, () => ({ path: nodeFsBrowser }));
  },
};

type MetafileInputs = Awaited<ReturnType<typeof esbuild.build>>['metafile'] extends infer M
  ? M extends { inputs: infer I }
    ? I
    : never
  : never;

// MEMOISED: five identical metafile builds became one. `s9lRKBym`.
//
// ⚠️ THIS IS NOT THE ENOMEM FIX, and the branch name says otherwise. esbuild's
// `ensureServiceIsRunning` caches one module-level service, so the healthy path
// already spawned once — memoising reduces requests to that process, not spawns
// of it. The `spawn ENOMEM` cause is parent heap at fork time, addressed by the
// cap in vitest.config.ts.
//
// The last test in this file still runs a SIXTH build (no metafile), so the
// count is five-to-two, not five-to-one.
//
// The memos CLEAR THEMSELVES ON REJECTION. `??=` would otherwise cache a
// rejected promise, so `--retry` (a CLI flag — nothing in the repo prevents
// someone passing it) would replay the cached failure instead of rebuilding,
// turning a retry into a no-op that looks deterministic. Two lines to remove
// the hazard rather than document it.
let metafileInputsPromise: Promise<MetafileInputs> | undefined;

async function browserMetafileInputs(): Promise<MetafileInputs> {
  metafileInputsPromise ??= buildBrowserMetafileInputs().catch((err) => {
    metafileInputsPromise = undefined;
    throw err;
  });
  return metafileInputsPromise;
}

async function buildBrowserMetafileInputs(): Promise<MetafileInputs> {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    metafile: true,
    logLevel: 'silent',
    plugins: [browserFieldRemap],
    // Node built-ins and the generated contracts package are not the subject
    // of this gate; mark them external so esbuild records edges without trying
    // to resolve/bundle them.
    external: ['node:*', '@giveitsmaller/contracts/*'],
  });
  return result.metafile.inputs as MetafileInputs;
}

// Memoised for the same reason: called twice, rebuilt each time.
let reachablePromise: Promise<Set<string>> | undefined;

async function staticReachable(): Promise<ReadonlySet<string>> {
  // ReadonlySet: the same Set object now goes to every caller, and a future
  // test that added or deleted an entry would corrupt the others with no
  // failure at the mutation site.
  reachablePromise ??= computeStaticReachable().catch((err) => {
    reachablePromise = undefined;
    throw err;
  });
  return reachablePromise;
}

async function computeStaticReachable(): Promise<Set<string>> {
  const inputs = await browserMetafileInputs();
  const entryKey = Object.keys(inputs).find((f) => f.endsWith('src/index.browser.ts'));
  if (entryKey === undefined) throw new Error('browser entry not found in metafile');

  const reachable = new Set<string>([entryKey]);
  const queue = [entryKey];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const imp of inputs[file]?.imports ?? []) {
      if (
        imp.kind === 'import-statement' &&
        !imp.external &&
        inputs[imp.path] !== undefined &&
        !reachable.has(imp.path)
      ) {
        reachable.add(imp.path);
        queue.push(imp.path);
      }
    }
  }
  return reachable;
}

async function staticNodeOffenders(): Promise<string[]> {
  const inputs = await browserMetafileInputs();
  const offenders: string[] = [];
  for (const file of await staticReachable()) {
    for (const imp of inputs[file]?.imports ?? []) {
      if (imp.path.startsWith('node:') && imp.kind === 'import-statement') {
        offenders.push(`${file} -> ${imp.path}`);
      }
    }
  }
  return offenders;
}

describe('browser entry — node-free static graph', () => {
  // No `esbuild.stop()`: it would free the service for the rest of the run,
  // but vitest transforms through esbuild too and whether that is the same
  // service instance is unverified. Not worth a speculative gain in the suite
  // being stabilised.

  it('has NO static node: import reachable from src/index.browser.ts', async () => {
    const offenders = await staticNodeOffenders();
    expect(offenders).toEqual([]);
  });

  it('resolves node-fs to the browser stub, never the node: version, in the static graph', async () => {
    const reachable = [...(await staticReachable())];
    // The browser stub (no node: imports) is what the path-upload code reaches...
    expect(reachable.some((f) => f.endsWith('src/node-fs.browser.ts'))).toBe(true);
    // ...and the Node node-fs.ts (which statically imports node:fs/promises) is NOT.
    expect(reachable.some((f) => f.endsWith('src/node-fs.ts'))).toBe(false);
    // http-downloader (node:fs/node:stream) is reached only via dynamic import.
    expect(reachable.some((f) => f.endsWith('src/http-downloader.ts'))).toBe(false);
  });

  it('keeps the credentials profile-read node:fs on a DYNAMIC edge (code-split, not main chunk)', async () => {
    const inputs = await browserMetafileInputs();
    const dynamicNodeEdges = new Set<string>();
    for (const [file, info] of Object.entries(inputs)) {
      for (const imp of info.imports ?? []) {
        if (imp.path.startsWith('node:') && imp.kind === 'dynamic-import') {
          dynamicNodeEdges.add(`${file.slice(file.indexOf('src/'))} -> ${imp.path}`);
        }
      }
    }
    expect(dynamicNodeEdges.has('src/credentials.ts -> node:fs/promises')).toBe(true);
  });

  it('bundles for the browser platform without error', async () => {
    await expect(
      esbuild.build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        platform: 'browser',
        format: 'esm',
        logLevel: 'silent',
        plugins: [browserFieldRemap],
        external: ['node:*', '@giveitsmaller/contracts/*'],
      }),
    ).resolves.toBeTruthy();
  });
});

describe('package.json browser field', () => {
  it('remaps node-fs (and the entry) to their browser variants', () => {
    const pkg = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8'));
    expect(pkg.browser).toMatchObject({
      './dist/index.js': './dist/index.browser.js',
      './dist/node-fs.js': './dist/node-fs.browser.js',
    });
  });
});

describe('browser entry — export surface', () => {
  it('is a strict subset of the node entry, omitting only the Node-only symbols', async () => {
    const browser = await import('../src/index.browser.js');
    const node = await import('../src/index.js');

    const browserKeys = new Set(Object.keys(browser));
    const nodeKeys = new Set(Object.keys(node));

    for (const key of browserKeys) {
      expect(nodeKeys.has(key)).toBe(true);
    }

    expect(browserKeys.has('gisl')).toBe(true);
    expect(browserKeys.has('GislClient')).toBe(true);

    expect(browserKeys.has('HttpDownloader')).toBe(false);
    expect(browserKeys.has('verifyWebhook')).toBe(false);

    const nodeOnly = [...nodeKeys].filter((k) => !browserKeys.has(k)).sort();
    expect(nodeOnly).toEqual(['HttpDownloader', 'verifyWebhook']);
  });
});
