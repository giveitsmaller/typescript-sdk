import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { GislClient, DEFAULT_MULTIPART_FIRST_CHUNK_SIZE } from '../../src/client.js';
import { SDKS_REPO_ROOT } from './_contract-paths.js';

/**
 * zdbFzaNX (DX A1a-TS) — the `ts` column of docs/parity/endpoints.yaml, proven
 * on the real TypeScript surface rather than read from the code by hand. The
 * TS twin of packages/php/tests/Unit/EndpointParityTest.php (UEygYT2E).
 *
 * For every row whose `ts` value is a method name or `{internal: m}`:
 *  - the method is a public, non-static method of `GislClient` as the BUILT
 *    package declares it: read with the TypeScript compiler API from every
 *    `types` entrypoint in package.json `exports`, resolving the `GislClient`
 *    export through its re-export aliases (so dropping a root re-export fails),
 *    and it is a function on `GislClient.prototype` at runtime;
 *  - invoking it against a stubbed `fetch` records exactly one request whose
 *    HTTP method, anchored path and host match the row's spec `location`
 *    (internal rows: their request appears exactly once inside one multipart
 *    `uploadFile` run, initiate before complete).
 *
 * For every `{gap: card}` row and every path-bearing `excluded` row, no request
 * recorded by the exercised methods matches its method and path.
 *
 * ⚠️ BOUND OF THE ABSENCE CHECK: only the methods in `INVOKERS` plus one
 * multipart `uploadFile` run are exercised. The unmapped public helpers
 * (`workflows()` pagination, `waitForWorkflow`, `waitForProbe`,
 * `maybeWaitForVideoProbe`, `createWorkflowAwaitingProbe`, `preflightClips`)
 * are NOT invoked, so this is not a whole-surface proof that no public method
 * issues a gap row's request.
 *
 * WHY `GislClient` IS THE BINDING SURFACE: `ErgonomicClient` is declared as the
 * intersection `GislClient & {...}` (src/gisl.ts), and the `create()` proxy
 * (`wrapErgonomic`) intercepts 15 properties, none of them a bound method,
 * falling through via `Reflect.get` for everything else. `gisl.anonymous()` is
 * a gated subset (`ANONYMOUS_ALLOWLIST`) and is out of scope here.
 */

const PKG_ROOT = resolve(SDKS_REPO_ROOT, 'packages/typescript');
const ENDPOINTS_YAML = resolve(SDKS_REPO_ROOT, 'docs/parity/endpoints.yaml');

const API_BASE_URL = 'https://api.example.com';
const API_HOST = 'api.example.com';
const STREAM_BASE_URL = 'https://stream.example.com';
const STREAM_HOST = 'stream.example.com';

/** The one method that targets the declared stream host, not baseUrl. */
const STREAM_METHOD = 'streamEvents';

/** The only public method whose internal requests are driven here. */
const INTERNAL_HOST_METHOD = 'uploadFile';

/** Enough queued responses that an unexpected extra request is RECORDED, not lost. */
const QUEUED_RESPONSES = 5;

// Multipart run, copied from client.test.ts `uploadFile multipart`: an 8 MiB
// first chunk sent with initiate plus one 16 MiB + 1 tail part via a presigned
// PUT to a THIRD host (neither API nor stream), so total_parts === 2.
const TAIL_CHUNK_SIZE = 16 * 1024 * 1024 + 1;
const BLOB_SIZE = DEFAULT_MULTIPART_FIRST_CHUNK_SIZE + TAIL_CHUNK_SIZE;

// ---------------------------------------------------------------------------
// YAML and partition
// ---------------------------------------------------------------------------

type Kind = 'method' | 'internal' | 'gap' | 'excluded';

interface Location {
  readonly method: string;
  readonly path: string | null;
}

interface Row {
  readonly operationId: string;
  readonly location: Location;
  readonly kind: Kind;
  /** Method name (method / internal), card id (gap) or reason (excluded). */
  readonly value: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The row's TS classification: exactly one of method / internal / gap / excluded. */
function classify(raw: Record<string, unknown>, id: string): { kind: Kind; value: string } {
  const hasExcluded = Object.prototype.hasOwnProperty.call(raw, 'excluded');
  const hasTs = Object.prototype.hasOwnProperty.call(raw, 'ts');
  if (hasExcluded === hasTs) {
    throw new Error(`${id}: a row is either excluded or has a ts value, exactly one`);
  }
  if (hasExcluded) {
    const reason = raw.excluded;
    if (typeof reason !== 'string' || reason === '') {
      throw new Error(`${id}: excluded needs a non-empty reason`);
    }
    return { kind: 'excluded', value: reason };
  }
  const tsValue = raw.ts;
  if (typeof tsValue === 'string' && tsValue !== '') {
    return { kind: 'method', value: tsValue };
  }
  if (isRecord(tsValue)) {
    const keys = Object.keys(tsValue);
    if (keys.length === 1) {
      const key = keys[0];
      const value = tsValue[key];
      if ((key === 'internal' || key === 'gap') && typeof value === 'string' && value !== '') {
        return { kind: key, value };
      }
    }
  }
  throw new Error(`${id}: ts must be a method name, {internal: m} or {gap: card}`);
}

function readLocation(raw: Record<string, unknown>, id: string): Location {
  const location = raw.location;
  if (!isRecord(location) || typeof location.method !== 'string') {
    throw new Error(`${id}: row location must carry a method`);
  }
  return {
    method: location.method,
    path: typeof location.path === 'string' ? location.path : null,
  };
}

function loadRows(): Row[] {
  const parsed: unknown = parseYaml(readFileSync(ENDPOINTS_YAML, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error(`${ENDPOINTS_YAML}: top level must be a list of rows`);
  }
  return parsed.map((entry: unknown): Row => {
    if (!isRecord(entry) || typeof entry.operationId !== 'string') {
      throw new Error(`${ENDPOINTS_YAML}: every row must be a mapping with a string operationId`);
    }
    const id = entry.operationId;
    return { operationId: id, location: readLocation(entry, id), ...classify(entry, id) };
  });
}

// Loaded at collection time: `it.each` needs the row ids before any test runs.
const ROWS: readonly Row[] = loadRows();

function rowsOfKind(...kinds: Kind[]): Row[] {
  return ROWS.filter((row) => kinds.includes(row.kind));
}

function row(operationId: string): Row {
  const found = ROWS.find((candidate) => candidate.operationId === operationId);
  if (found === undefined) throw new Error(`No row for operationId ${operationId}`);
  return found;
}

const BOUND_IDS: string[] = rowsOfKind('method', 'internal').map((r) => r.operationId);
const DIRECT_IDS: string[] = rowsOfKind('method').map((r) => r.operationId);

// ---------------------------------------------------------------------------
// (1) Existence on the BUILT surface
// ---------------------------------------------------------------------------

// Copied from tests/api-surface.test.ts (createRelativeOnlyProgram and its
// helpers): bare specifiers resolve to nothing, so the read cannot depend on
// what happens to be installed in node_modules.
const COMPILER_OPTIONS: ts.CompilerOptions = {
  noLib: true,
  target: ts.ScriptTarget.Latest,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};

function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const stripped = base.replace(/\.js$/, '');
  for (const candidate of [`${stripped}.ts`, `${stripped}.d.ts`, `${base}.ts`, `${base}.d.ts`]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const isRelative = (specifier: string): boolean => specifier.startsWith('.');

function createRelativeOnlyProgram(entryFiles: readonly string[]): ts.Program {
  const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
  host.resolveModuleNameLiterals = (literals, containingFile): ts.ResolvedModuleWithFailedLookupLocations[] =>
    literals.map((literal) => {
      const specifier = literal.text;
      if (!isRelative(specifier)) return { resolvedModule: undefined };
      const resolvedFileName = resolveRelative(containingFile, specifier);
      if (resolvedFileName === undefined) return { resolvedModule: undefined };
      return {
        resolvedModule: {
          resolvedFileName,
          extension: resolvedFileName.endsWith('.d.ts') ? ts.Extension.Dts : ts.Extension.Ts,
        },
      };
    });
  return ts.createProgram([...entryFiles], COMPILER_OPTIONS, host);
}

/** Every `types` path package.json exposes under `exports`, plus top-level `types`. */
function typesEntrypoints(): string[] {
  const manifest: unknown = JSON.parse(readFileSync(resolve(PKG_ROOT, 'package.json'), 'utf8'));
  if (!isRecord(manifest)) throw new Error('package.json is not an object');
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (!isRecord(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'types' && typeof value === 'string') found.add(value);
      else walk(value);
    }
  };
  walk(manifest.exports);
  if (typeof manifest.types === 'string') found.add(manifest.types);
  return [...found].map((relative) => resolve(PKG_ROOT, relative)).sort();
}

/**
 * Public, non-static method names of the `GislClient` class that `entryFile`
 * exports, followed through every alias. Private members are emitted into a
 * .d.ts as property declarations (`private foo;`), so filtering on
 * MethodDeclaration plus the modifier check is what makes this "public".
 */
function publicGislClientMethods(entryFile: string): Set<string> {
  const program = createRelativeOnlyProgram([entryFile]);
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(entryFile);
  if (sourceFile === undefined) throw new Error(`${entryFile}: not in the program`);
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol === undefined) throw new Error(`${entryFile}: no module symbol`);

  const exported = checker.getExportsOfModule(moduleSymbol).find((s) => s.getName() === 'GislClient');
  if (exported === undefined) throw new Error(`${entryFile}: does not export GislClient`);
  const target =
    (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported;
  const classDeclaration = (target.declarations ?? []).find(
    (declaration): declaration is ts.ClassDeclaration => ts.isClassDeclaration(declaration),
  );
  if (classDeclaration === undefined) {
    throw new Error(`${entryFile}: GislClient does not resolve to a class declaration`);
  }

  const methods = new Set<string>();
  for (const member of classDeclaration.members) {
    if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
    const flags = ts.getCombinedModifierFlags(member);
    if ((flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Static)) !== 0) {
      continue;
    }
    methods.add(member.name.text);
  }
  return methods;
}

let builtSurfaceCache: Map<string, Set<string>> | null = null;

/** Entrypoint file -> its GislClient public method set. Built once. */
function builtSurface(): Map<string, Set<string>> {
  if (builtSurfaceCache === null) {
    const surface = new Map<string, Set<string>>();
    for (const entry of typesEntrypoints()) surface.set(entry, publicGislClientMethods(entry));
    builtSurfaceCache = surface;
  }
  return builtSurfaceCache;
}

/** Null when every entrypoint declares `method` publicly and the prototype has it, else why not. */
function existenceFailure(surface: ReadonlyMap<string, ReadonlySet<string>>, method: string): string | null {
  for (const [entry, methods] of surface) {
    if (!methods.has(method)) return `${entry}: GislClient has no public method ${method}`;
  }
  const prototype = GislClient.prototype as unknown as Record<string, unknown>;
  if (typeof prototype[method] !== 'function') {
    return `GislClient.prototype.${method} is not a function at runtime`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// (2) Binding: recording, matching
// ---------------------------------------------------------------------------

interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
}

type Invoker = (client: GislClient) => Promise<unknown>;

/**
 * Minimal valid calls, keyed by TS method name. Every argument passes the
 * method's own pre-send validation, so the request is actually issued.
 *
 * Payload-taking methods get a minimal non-null object of their request type;
 * the cast is deliberate, because the request body is not the subject here.
 */
const INVOKERS: Readonly<Record<string, Invoker>> = {
  uploadFile: (c) => c.uploadFile(new Blob([new Uint8Array(16)])),
  // Can page, but the generic stub fails page-one validation (no total_parts),
  // so exactly one request is recorded. Deliberate: paging is not the subject.
  getUploadStatus: (c) => c.getUploadStatus('upl_x'),
  // Part numbers must lie in [2, totalParts]: part 1 is sealed at initiate.
  presignParts: (c) => c.presignParts('upl_x', [2], 2),
  keepaliveUpload: (c) => c.keepaliveUpload('upl_x'),
  getMetadata: (c) => c.getMetadata('file_x'),
  probeUpload: (c) => c.probeUpload('file_x'),
  // One page only: listWorkflows never follows nextCursor (workflows() does).
  listWorkflows: (c) => c.listWorkflows(),
  createWorkflow: (c) => c.createWorkflow({ jobs: [] } as Parameters<GislClient['createWorkflow']>[0]),
  getWorkflowStatus: (c) => c.getWorkflowStatus('wf_x'),
  getWorkflowDownloads: (c) => c.getWorkflowDownloads('wf_x'),
  // The fetch is issued before the generator is returned; release it after.
  streamEvents: async (c) => {
    const stream = await c.streamEvents('wf_x');
    await stream.return(undefined);
  },
  cancelWorkflow: (c) => c.cancelWorkflow('wf_x'),
  resumeWorkflow: (c) => c.resumeWorkflow('wf_x'),
  archiveWorkflow: (c) => c.archiveWorkflow('wf_x'),
  restoreWorkflow: (c) => c.restoreWorkflow('wf_x'),
  getSchema: (c) => c.getSchema(),
  retryOperation: (c) => c.retryOperation('op_x'),
  getHealth: (c) => c.getHealth(),
  login: (c) =>
    c.login({ email: 'user@example.com', password: 'secret' } as Parameters<GislClient['login']>[0]),
  logout: (c) => c.logout(),
  getProfile: (c) => c.getProfile(),
  createExternalImport: (c) =>
    c.createExternalImport({ url: 'https://files.example.org/a.jpg' } as Parameters<
      GislClient['createExternalImport']
    >[0]),
  decodeAudioWatermark: (c) =>
    c.decodeAudioWatermark({ fileId: 'file_x' } as Parameters<GislClient['decodeAudioWatermark']>[0]),
  getCreditsBalance: (c) => c.getCreditsBalance(),
  getCreditsUsage: (c) => c.getCreditsUsage(),
  getAccountLimits: (c) => c.getAccountLimits(),
  createCheckoutSession: (c) =>
    c.createCheckoutSession({ type: 'pack', key: 'pack_10' } as Parameters<
      GislClient['createCheckoutSession']
    >[0]),
  getCheckoutSessionStatus: (c) => c.getCheckoutSessionStatus('cs_x'),
  submitContact: (c) =>
    c.submitContact({ email: 'user@example.com', subject: 'general_enquiry', message: 'hi' } as Parameters<
      GislClient['submitContact']
    >[0]),
};

function hasInvoker(method: string): boolean {
  return Object.prototype.hasOwnProperty.call(INVOKERS, method);
}

function newClient(): GislClient {
  return new GislClient({
    baseUrl: API_BASE_URL,
    apiKey: 'test-key',
    // Declared, so streamEvents exercises its request rather than the
    // fail-closed guard (proved in stream-host.test.ts).
    streamBaseUrl: STREAM_BASE_URL,
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const genericJson = (): Response => jsonResponse({ success: true, data: {} });
const emptySse = (): Response =>
  new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

/**
 * Stub `fetch` with a queue of QUEUED_RESPONSES response FACTORIES — a body can
 * be read only once, so every call gets a fresh Response. Calls past the queue
 * reject, but are still recorded by the spy.
 */
function stubFetch(first: ReadonlyArray<() => Response>, fallback: () => Response): ReturnType<typeof vi.fn> {
  let callIndex = 0;
  const spy = vi.fn();
  spy.mockImplementation(async (): Promise<Response> => {
    const index = callIndex;
    callIndex += 1;
    if (index >= QUEUED_RESPONSES) throw new Error(`fetch stub: queue of ${QUEUED_RESPONSES} exhausted`);
    return (first[index] ?? fallback)();
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function requestsOf(spy: ReturnType<typeof vi.fn>): RecordedRequest[] {
  return spy.mock.calls.map((call: unknown[]): RecordedRequest => {
    const input = call[0];
    const init = call[1] as RequestInit | undefined;
    let href: string;
    let inputMethod: string | undefined;
    if (typeof input === 'string') href = input;
    else if (input instanceof URL) href = input.href;
    else if (input instanceof Request) {
      href = input.url;
      inputMethod = input.method;
    } else throw new Error(`fetch called with an unrecognised input: ${String(input)}`);
    return { method: (init?.method ?? inputMethod ?? 'GET').toUpperCase(), url: new URL(href) };
  });
}

/**
 * Invoke one mapped method and return every request it recorded. Errors are
 * swallowed: response hydration is not the subject, the request is, and an
 * empty record still fails the exactly-one check.
 */
async function record(method: string): Promise<RecordedRequest[]> {
  if (!hasInvoker(method)) {
    throw new Error(`No invoker for ${method}: a mapped method must be exercised, never skipped`);
  }
  const spy = stubFetch([], method === STREAM_METHOD ? emptySse : genericJson);
  try {
    await INVOKERS[method](newClient());
  } catch {
    // See docblock.
  } finally {
    vi.unstubAllGlobals();
  }
  return requestsOf(spy);
}

/**
 * Anchored regex for a spec path: literal segments escaped, each `{param}`
 * exactly one non-empty path segment.
 */
function pathRegex(specPath: string): RegExp {
  const source = specPath
    .split(/(\{[^}/]+\})/)
    .map((part) => (/^\{[^}/]+\}$/.test(part) ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`);
}

type Mismatches = Partial<Record<'method' | 'path' | 'host', string>>;

/**
 * Mismatches between a recorded request and a spec location, keyed by what
 * differs ('method', 'path', 'host', in that order); empty when it matches.
 * The query string is ignored.
 */
function locationMismatches(request: RecordedRequest, location: Location, expectedHost: string): Mismatches {
  const mismatches: Mismatches = {};
  const expectedMethod = location.method.toUpperCase();
  if (request.method !== expectedMethod) {
    mismatches.method = `${request.method} != ${expectedMethod}`;
  }
  if (location.path === null || !pathRegex(location.path).test(request.url.pathname)) {
    mismatches.path = `${request.url.pathname} !~ ${location.path ?? '(no path)'}`;
  }
  if (request.url.hostname !== expectedHost) {
    mismatches.host = `${request.url.hostname} != ${expectedHost}`;
  }
  return mismatches;
}

function exactlyOneFailure(requests: readonly RecordedRequest[]): string | null {
  return requests.length === 1 ? null : `expected exactly one request, recorded ${requests.length}`;
}

// ---------------------------------------------------------------------------
// (3) Internal rows: one multipart uploadFile run
// ---------------------------------------------------------------------------

let multipartCache: RecordedRequest[] | null = null;

/** initiate, S3 PUT, complete — the mockMultipartFlow queue from client.test.ts. */
async function multipartRequests(): Promise<RecordedRequest[]> {
  if (multipartCache === null) {
    const spy = stubFetch(
      [
        // 1) POST /api/uploads/multipart/initiate
        () =>
          jsonResponse({
            success: true,
            data: {
              upload_id: 'upload-mp-1',
              mime_type: 'application/octet-stream',
              first_chunk_etag: '"etag-part-1"',
              first_chunk_size_bytes: DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
              total_parts: 2,
              recommended_chunk_size: TAIL_CHUNK_SIZE,
              presigned_urls: [
                {
                  part_number: 2,
                  url: 'https://s3.example.com/upload?part=2',
                  expires_at: '2026-04-18T09:00:00.000Z',
                },
              ],
            },
          }),
        // 2) PUT to the presigned S3 URL: a third host, neither API nor stream.
        () => new Response('', { status: 200, headers: { etag: '"etag-part-2"' } }),
        // 3) POST /api/uploads/multipart/complete (201 + {upload_id, status})
        () => jsonResponse({ success: true, data: { upload_id: 'upload-mp-1', status: 'completed' } }, 201),
      ],
      genericJson,
    );
    try {
      await newClient().uploadFile(new Blob([new Uint8Array(BLOB_SIZE)]));
    } finally {
      vi.unstubAllGlobals();
    }
    multipartCache = requestsOf(spy);
  }
  return multipartCache;
}

// ---------------------------------------------------------------------------
// (4) Absence helper
// ---------------------------------------------------------------------------

/**
 * Requests that hit a gap or excluded row's method + path (on any host), and
 * how many path-bearing rows were checked. A row without a path (the outbound
 * webhook: {webhook, method}) is skipped only when it is excluded.
 */
function absenceViolations(
  requests: readonly RecordedRequest[],
  rows: readonly Row[],
): { violations: string[]; checked: number } {
  const violations: string[] = [];
  let checked = 0;
  for (const candidate of rows) {
    if (candidate.location.path === null) {
      if (candidate.kind !== 'excluded') {
        violations.push(`${candidate.operationId}: only an excluded row may lack a path`);
      }
      continue;
    }
    for (const request of requests) {
      if (Object.keys(locationMismatches(request, candidate.location, request.url.hostname)).length === 0) {
        violations.push(
          `${candidate.operationId}: ${request.method} ${request.url.pathname} was issued by an exercised method`,
        );
      }
    }
    checked += 1;
  }
  return { violations, checked };
}

function syntheticRequest(method: string, url: string): RecordedRequest {
  return { method: method.toUpperCase(), url: new URL(url) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('endpoint parity: docs/parity/endpoints.yaml ts column on the real client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('every row is exactly one kind and the bound set is the method and internal rows', () => {
    expect(ROWS.length).toBeGreaterThan(0);
    const counts: Record<Kind, number> = { method: 0, internal: 0, gap: 0, excluded: 0 };
    for (const r of ROWS) counts[r.kind] += 1;

    expect(counts.method + counts.internal + counts.gap + counts.excluded).toBe(ROWS.length);
    expect(counts.method).toBeGreaterThan(0);
    expect(counts.internal).toBeGreaterThan(0);
    expect(BOUND_IDS).toEqual(
      ROWS.filter((r) => r.kind === 'method' || r.kind === 'internal').map((r) => r.operationId),
    );
  });

  describe('(1) existence on the built surface', () => {
    it('reads every package.json types entrypoint, and each exports GislClient with methods', () => {
      const surface = builtSurface();
      const entries = [...surface.keys()].map((entry) => entry.slice(PKG_ROOT.length + 1));
      expect(entries).toContain('dist/index.d.ts');
      expect(entries).toContain('dist/index.browser.d.ts');
      for (const methods of surface.values()) expect(methods.size).toBeGreaterThan(0);
    });

    it.each(BOUND_IDS)('%s: bound method is public on every built entrypoint and on the prototype', (operationId) => {
      expect(existenceFailure(builtSurface(), row(operationId).value)).toBeNull();
    });
  });

  describe('(2) binding, direct rows', () => {
    it.each(DIRECT_IDS)('%s: issues exactly one request to its spec location', async (operationId) => {
      const r = row(operationId);
      const requests = await record(r.value);

      expect(exactlyOneFailure(requests)).toBeNull();
      const expectedHost = r.value === STREAM_METHOD ? STREAM_HOST : API_HOST;
      expect(locationMismatches(requests[0], r.location, expectedHost)).toEqual({});
    });
  });

  describe('(3) binding, internal rows', () => {
    it('each internal row is issued exactly once inside one multipart uploadFile run, initiate before complete', async () => {
      const requests = await multipartRequests();
      const internalRows = rowsOfKind('internal');
      expect(internalRows.length).toBeGreaterThan(0);

      const positions = new Map<string, number>();
      for (const r of internalRows) {
        expect(r.value, `${r.operationId}: only {internal: ${INTERNAL_HOST_METHOD}} is driven here`).toBe(
          INTERNAL_HOST_METHOD,
        );
        expect(hasInvoker(r.value), `${r.operationId}: internal host method has no invoker`).toBe(true);

        const matches: number[] = [];
        requests.forEach((request, index) => {
          if (Object.keys(locationMismatches(request, r.location, API_HOST)).length === 0) matches.push(index);
        });
        expect(matches, `${r.operationId}: expected its request exactly once in the uploadFile run`).toHaveLength(1);
        positions.set(r.operationId, matches[0]);
      }

      const initiate = positions.get('multipartInitiate');
      const complete = positions.get('multipartComplete');
      expect(initiate).toBeDefined();
      expect(complete).toBeDefined();
      expect(initiate as number).toBeLessThan(complete as number);
    });
  });

  describe('(4) absence, gap and excluded rows', () => {
    it('no exercised method issues a gap or excluded row request', async () => {
      const multipart = await multipartRequests();
      const recorded: RecordedRequest[] = [...multipart];
      for (const method of Object.keys(INVOKERS)) recorded.push(...(await record(method)));
      // Pin the inputs: every invoker contributes exactly one request (the
      // direct-row test proves that), so a dropped invoker loop is caught here.
      expect(recorded.length).toBe(multipart.length + Object.keys(INVOKERS).length);

      const unbound = rowsOfKind('gap', 'excluded');
      const { violations, checked } = absenceViolations(recorded, unbound);

      expect(violations).toEqual([]);
      // Every path-bearing gap AND excluded row was checked, so narrowing the
      // row set (e.g. to gap only) is caught.
      expect(checked).toBe(unbound.filter((r) => r.location.path !== null).length);
      expect(unbound.some((r) => r.kind === 'excluded' && r.location.path !== null)).toBe(true);
    });
  });

  describe('(5) invoker map completeness', () => {
    it('the invoker map and the YAML name the same methods', () => {
      const named = [...new Set(rowsOfKind('method', 'internal').map((r) => r.value))].sort();
      const invokerKeys = Object.keys(INVOKERS).sort();

      expect(named.filter((m) => !invokerKeys.includes(m)), 'methods named in the YAML with no invoker').toEqual([]);
      expect(invokerKeys.filter((m) => !named.includes(m)), 'invokers no row names').toEqual([]);
    });
  });

  describe('(6) negative controls through the same pure helpers', () => {
    it('a misspelt method is absent from the built member set', () => {
      const surface = builtSurface();
      const [firstEntry] = [...surface.keys()];

      // Positive control: the real name IS found, so the miss below is the spelling.
      expect(existenceFailure(surface, 'getHealth')).toBeNull();
      expect(existenceFailure(surface, 'getHelth')).toBe(`${firstEntry}: GislClient has no public method getHelth`);
      for (const methods of surface.values()) expect(methods.has('getHelth')).toBe(false);
    });

    it("getHealth's request checked against the logoutUser row fails on method and path", async () => {
      const requests = await record('getHealth');
      expect(exactlyOneFailure(requests)).toBeNull();

      const mismatches = locationMismatches(requests[0], row('logoutUser').location, API_HOST);

      expect(Object.keys(mismatches)).toEqual(['method', 'path']);
      expect(mismatches.method).toBe('GET != POST');
      expect(mismatches.path).toBe('/healthz !~ /api/auth/logout');
    });

    it('a {param} path does not match a different literal segment nor a two-segment value', () => {
      const location: Location = { method: 'get', path: '/api/workflows/{id}/status' };

      expect(
        locationMismatches(syntheticRequest('GET', `${API_BASE_URL}/api/workflows/wf_x/status`), location, API_HOST),
      ).toEqual({});
      expect(
        Object.keys(
          locationMismatches(syntheticRequest('GET', `${API_BASE_URL}/api/workflows/wf_x/downloads`), location, API_HOST),
        ),
      ).toEqual(['path']);
      // {param} is one segment: it cannot swallow a slash.
      expect(
        Object.keys(locationMismatches(syntheticRequest('GET', `${API_BASE_URL}/api/workflows/a/b/status`), location, API_HOST)),
      ).toEqual(['path']);
    });

    it('a path with a prefix or a suffix does not match', () => {
      const location: Location = { method: 'get', path: '/api/workflows/{id}/status' };

      for (const path of ['/api/workflows/wf_x/status/extra', '/prefix/api/workflows/wf_x/status']) {
        expect(
          Object.keys(locationMismatches(syntheticRequest('GET', `${API_BASE_URL}${path}`), location, API_HOST)),
          path,
        ).toEqual(['path']);
      }
    });

    it('a stream-host request checked against the API host fails on host only', () => {
      const location: Location = { method: 'get', path: '/api/workflows/{id}/events' };
      const mismatches = locationMismatches(
        syntheticRequest('GET', `${STREAM_BASE_URL}/api/workflows/wf_x/events`),
        location,
        API_HOST,
      );

      expect(Object.keys(mismatches)).toEqual(['host']);
      expect(mismatches.host).toBe(`${STREAM_HOST} != ${API_HOST}`);
    });

    it('a path-less row that is not excluded is an absence violation', () => {
      const webhook = row('webhookWorkflowCallback');
      expect(webhook.location.path).toBeNull();
      const notExcluded: Row = { ...webhook, kind: 'gap', value: 'AbCd1234' };

      const { violations, checked } = absenceViolations([], [notExcluded]);

      expect(checked).toBe(0);
      expect(violations).toEqual(['webhookWorkflowCallback: only an excluded row may lack a path']);
    });

    it('a synthetic request to the readiness gap row is an absence violation', () => {
      const readiness = row('readiness');
      expect(readiness.kind).toBe('gap');
      expect(readiness.location.path).not.toBeNull();
      const request = syntheticRequest(readiness.location.method, `${API_BASE_URL}${readiness.location.path ?? ''}`);

      const { violations, checked } = absenceViolations([request], [readiness]);

      expect(checked).toBe(1);
      expect(violations).toEqual([
        `readiness: ${request.method} ${readiness.location.path ?? ''} was issued by an exercised method`,
      ]);
    });

    it('a two-request record fails exactly-one', () => {
      const one = syntheticRequest('GET', `${API_BASE_URL}/healthz`);

      expect(exactlyOneFailure([one, one])).toBe('expected exactly one request, recorded 2');
      expect(exactlyOneFailure([])).toBe('expected exactly one request, recorded 0');
    });
  });
});
