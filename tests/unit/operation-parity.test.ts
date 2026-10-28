import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { create, type ErgonomicClient } from '../../src/gisl.js';
import { GislClient } from '../../src/client.js';
import type { SplitOptions } from '../../src/ergonomic/option_types.js';
import type { OperationDef, WorkflowCreatePayload } from '../../src/types.js';
import { SDKS_REPO_ROOT } from './_contract-paths.js';
import { PKG_ROOT, intersectionLiteralMembers, publicClassMethods, typesEntrypoints } from './_built-surface.js';

/**
 * xybG2CzQ (DX A1b-TS) — the `ts` column of docs/parity/operations.yaml, proven
 * on the real TypeScript surface rather than read from the code by hand. The
 * PHP twin is card tfdUA2Sl.
 *
 * For every REQUIRED row (availability `stable` or `beta`; planned rows are
 * listed, not required) and every REACHABLE `ts` entry on it (a file-first step,
 * a client method, or `{generic: operation}`; `gap` and `excluded` are skipped):
 *  - (1) the member is declared on the BUILT surface of every `types`
 *    entrypoint: `Recipe` for `via: file`, `FilesRecipe` for `via: files`, and
 *    the TYPE-LITERAL half of `ErgonomicClient` for a client method and for
 *    `operation`, so a same-named `GislClient` member cannot satisfy a verb row;
 *  - (2) the method, looked up BY THE YAML NAME on a real `create()` client and
 *    called with stub Blobs typed with the group's first MIME, `submit()`s
 *    without a local refusal and sends ONE workflow-create whose only
 *    non-`passthrough` operation is the row's operation (the passthrough row:
 *    exactly one bare passthrough), built over exactly the stubs it was given.
 *
 * Transport: `uploadFile`, `maybeWaitForVideoProbe` and `createWorkflow` are
 * stubbed on the prototype and `fetch` is a rejecting fence, so nothing reaches
 * a server. Inputs are a few stub bytes in a typed Blob, never media (owner
 * decision 839).
 *
 * ⚠️ BOUND: this proves the SDK SENDS the row's operation for the group's FIRST
 * MIME. It does not prove the server accepts it, nor that every MIME of the
 * group routes the same way.
 */

const OPERATIONS_YAML = resolve(SDKS_REPO_ROOT, 'docs/parity/operations.yaml');
const AVAILABILITY_JSON = resolve(SDKS_REPO_ROOT, 'generated/typescript/availability/availability.json');

const API_BASE_URL = 'https://api.example.com';

/** The contract's `sdk_exposure: expose` rungs: a row on one of them is required (YAML header). */
const REQUIRED_AVAILABILITY: readonly string[] = ['stable', 'beta'];

/** Required rows when this test was written; fewer means rows were dropped, not proven. */
const MIN_REQUIRED_ROWS = 38;

/** The source op merge / archive / watermark lower each upload through; not the row's operation. */
const PASSTHROUGH = 'passthrough';

/** A few bytes, never media (owner decision 839): only the Blob's `type` matters to routing. */
const STUB_BYTES = new Uint8Array([0x47, 0x49, 0x53, 0x4c]);

// ---------------------------------------------------------------------------
// YAML and availability.json
// ---------------------------------------------------------------------------

type Entry =
  | { readonly kind: 'file-first'; readonly via: 'file' | 'files'; readonly step: string }
  | { readonly kind: 'client'; readonly method: string }
  | { readonly kind: 'generic' };

interface Row {
  readonly operation: string;
  readonly group: string | null;
  readonly availability: string;
  /** The reachable TS entries; `gap` and `excluded` ones are not listed. */
  readonly entries: readonly Entry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== '';

const rowId = (row: Pick<Row, 'operation' | 'group'>): string => `${row.operation}/${row.group ?? 'null'}`;

/** `{via, step}` is reachable; `{gap}` / `{excluded}` is not (null). Anything else is a YAML error. */
function fileFirstEntry(value: unknown, id: string): Entry | null {
  if (isRecord(value)) {
    const keys = Object.keys(value).sort().join(',');
    if (keys === 'step,via' && (value.via === 'file' || value.via === 'files') && isNonEmptyString(value.step)) {
      return { kind: 'file-first', via: value.via, step: value.step };
    }
    if ((keys === 'gap' || keys === 'excluded') && isNonEmptyString(value[keys])) return null;
  }
  throw new Error(`${id}: ts.file_first must be {via: file|files, step}, {gap: card} or {excluded: reason}`);
}

/** A method name or `{generic: operation}` is reachable; `{gap}` is not (null). */
function clientEntry(value: unknown, id: string): Entry | null {
  if (isNonEmptyString(value)) return { kind: 'client', method: value };
  if (isRecord(value) && Object.keys(value).length === 1) {
    if (value.generic === 'operation') return { kind: 'generic' };
    if (isNonEmptyString(value.gap)) return null;
  }
  throw new Error(`${id}: ts.client must be a method name, {generic: operation} or {gap: card}`);
}

function loadRequiredRows(): Row[] {
  const parsed: unknown = parseYaml(readFileSync(OPERATIONS_YAML, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${OPERATIONS_YAML}: top level must be a list of rows`);
  const rows: Row[] = [];
  for (const raw of parsed as unknown[]) {
    if (
      !isRecord(raw) ||
      typeof raw.operation !== 'string' ||
      typeof raw.availability !== 'string' ||
      !(raw.group === null || typeof raw.group === 'string')
    ) {
      throw new Error(`${OPERATIONS_YAML}: every row needs a string operation and availability, and a group`);
    }
    if (!REQUIRED_AVAILABILITY.includes(raw.availability)) continue;
    const id = rowId({ operation: raw.operation, group: raw.group });
    if (!isRecord(raw.ts)) throw new Error(`${id}: a required row needs a ts mapping`);
    const entries = [fileFirstEntry(raw.ts.file_first, id), clientEntry(raw.ts.client, id)].filter(
      (entry): entry is Entry => entry !== null,
    );
    rows.push({ operation: raw.operation, group: raw.group, availability: raw.availability, entries });
  }
  return rows;
}

interface OptionSpec {
  readonly required?: boolean;
  readonly values?: readonly string[];
  readonly per_value_availability?: Readonly<Record<string, { readonly availability?: string }>>;
}

interface MimeGroup {
  readonly mimes: readonly string[];
  readonly options?: Readonly<Record<string, OptionSpec>>;
}

const AVAILABILITY = JSON.parse(readFileSync(AVAILABILITY_JSON, 'utf8')) as {
  readonly operations: Readonly<Record<string, { readonly mime_groups?: Readonly<Record<string, MimeGroup>> }>>;
};

function mimeGroup(row: Row): MimeGroup {
  const group = row.group === null ? undefined : AVAILABILITY.operations[row.operation]?.mime_groups?.[row.group];
  if (group === undefined) throw new Error(`${rowId(row)}: no such mime_group in availability.json`);
  return group;
}

/** The MIME every stub of a grouped row carries: the group's first. Null for an ungrouped row. */
function groupMime(row: Row): string | null {
  if (row.group === null) return null;
  const [first] = mimeGroup(row).mimes;
  if (first === undefined) throw new Error(`${rowId(row)}: mime_group lists no mimes`);
  return first;
}

/** The first value of an enum option that is not `planned`: one a caller can actually send. */
function firstShippableValue(row: Row, option: string): string {
  const spec = mimeGroup(row).options?.[option];
  const value = spec?.values?.find((candidate) => spec.per_value_availability?.[candidate]?.availability !== 'planned');
  if (value === undefined) throw new Error(`${rowId(row)}: ${option} has no non-planned value in availability.json`);
  return value;
}

// Loaded at collection time: `it.each` needs the cases before any test runs.
const REQUIRED_ROWS: readonly Row[] = loadRequiredRows();

interface Case {
  readonly id: string;
  readonly row: Row;
  readonly entry: Entry;
}

function entryLabel(entry: Entry): string {
  switch (entry.kind) {
    case 'file-first':
      return `${entry.via === 'file' ? 'file(x)' : 'files([a, b])'}.${entry.step}`;
    case 'client':
      return `client.${entry.method}`;
    case 'generic':
      return 'client.operation';
  }
}

const CASES: Case[] = REQUIRED_ROWS.flatMap((row) =>
  row.entries.map((entry): Case => ({ id: `${rowId(row)} ${entryLabel(entry)}`, row, entry })),
);

function requiredRow(operation: string, group: string): Row {
  const found = REQUIRED_ROWS.find((row) => row.operation === operation && row.group === group);
  if (found === undefined) throw new Error(`No required row ${operation}/${group}`);
  return found;
}

// ---------------------------------------------------------------------------
// (1) Existence on the BUILT surface
// ---------------------------------------------------------------------------

type SurfaceType = 'Recipe' | 'FilesRecipe' | 'ErgonomicClient';

interface Member {
  readonly type: SurfaceType;
  readonly name: string;
}

function memberOf(entry: Entry): Member {
  switch (entry.kind) {
    case 'file-first':
      return { type: entry.via === 'file' ? 'Recipe' : 'FilesRecipe', name: entry.step };
    case 'client':
      return { type: 'ErgonomicClient', name: entry.method };
    case 'generic':
      return { type: 'ErgonomicClient', name: 'operation' };
  }
}

/** The unique (type, member) pairs the required rows name: each is checked once. */
const REQUIRED_MEMBERS: Member[] = [
  ...new Map(CASES.map(({ entry }) => memberOf(entry)).map((m) => [`${m.type}.${m.name}`, m])).values(),
];

type Surface = ReadonlyMap<string, Readonly<Record<SurfaceType, ReadonlySet<string>>>>;

let builtSurfaceCache: Surface | null = null;

/** Entrypoint file -> the declared members of each surface type. Built once. */
function builtSurface(): Surface {
  if (builtSurfaceCache === null) {
    const surface = new Map<string, Record<SurfaceType, Set<string>>>();
    for (const entry of typesEntrypoints()) {
      surface.set(entry, {
        Recipe: publicClassMethods(entry, 'Recipe'),
        FilesRecipe: publicClassMethods(entry, 'FilesRecipe'),
        ErgonomicClient: intersectionLiteralMembers(entry, 'ErgonomicClient'),
      });
    }
    builtSurfaceCache = surface;
  }
  return builtSurfaceCache;
}

const relativeEntry = (entry: string): string => entry.slice(PKG_ROOT.length + 1);

/** One line per (entrypoint, member) the surface does not declare; empty when all are. */
function existenceFailures(surface: Surface, members: readonly Member[]): string[] {
  const failures: string[] = [];
  for (const [entry, declared] of surface) {
    for (const { type, name } of members) {
      if (!declared[type].has(name)) failures.push(`${relativeEntry(entry)}: ${type} declares no public ${name}`);
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// (2) Binding: call by the YAML name, capture the one workflow-create
// ---------------------------------------------------------------------------

/**
 * Split's required key differs per group and GIF `frame_range` has no contract default, so the
 * values are literals. Each literal `mode` is checked against the group's shippable `mode.values`
 * in availability.json (splitOptions), so a contract change to the modes goes red here.
 */
const SPLIT_OPTIONS: Readonly<Record<string, SplitOptions>> = {
  image_gif: { frame_range: '1-10' },
  document_pdf: { mode: 'page_range', page_range: '1-2' },
  audio: { mode: 'interval', interval: 10 },
  video: { mode: 'interval', interval: 10 },
};

function splitOptions(row: Row): SplitOptions {
  const options = row.group === null ? undefined : SPLIT_OPTIONS[row.group];
  if (options === undefined) throw new Error(`${rowId(row)}: no split options for this group; add them, never skip the row`);
  const { mode } = options as { readonly mode?: string };
  if (mode !== undefined) {
    const modes = mimeGroup(row).options?.['mode'];
    const shippable = modes?.values?.includes(mode) === true && modes.per_value_availability?.[mode]?.availability !== 'planned';
    if (!shippable) throw new Error(`${rowId(row)}: split mode '${mode}' is not a shippable mode.values entry in availability.json; update SPLIT_OPTIONS`);
  }
  return options;
}

/** Image merge has no `output_type` default and is refused locally without one. */
const mergeOptions = (row: Row): { output: string } => ({ output: firstShippableValue(row, 'output_type') });

/** File-first step arguments, keyed by step name. `overlays` are extra uploads the arguments carry. */
function fileFirstArgs(client: ErgonomicClient, row: Row, step: string): { args: unknown[]; overlays: Blob[] } {
  switch (step) {
    case 'compress':
    case 'thumbnail':
    case 'archive':
      return { args: [], overlays: [] };
    case 'convert':
      return { args: [firstShippableValue(row, 'output_format')], overlays: [] };
    case 'textWatermark':
      return { args: ['GISL'], overlays: [] };
    case 'split':
      return { args: [splitOptions(row)], overlays: [] };
    case 'merge':
      return { args: [mergeOptions(row)], overlays: [] };
    case 'watermark': {
      // Any image overlay; only the base carries the group's MIME.
      const overlay = new Blob([STUB_BYTES], { type: 'image/png' });
      return { args: [client.file(overlay)], overlays: [overlay] };
    }
    default:
      throw new Error(`${rowId(row)}: no arguments for file-first step ${step}; add them, never skip the row`);
  }
}

/** Client method arguments, keyed by method name (options LAST). */
function clientArgs(row: Row, method: string, inputs: readonly Blob[]): unknown[] {
  switch (method) {
    case 'compress':
    case 'thumbnail':
      return [inputs[0]];
    case 'convert':
      return [inputs[0], firstShippableValue(row, 'output_format')];
    case 'split':
      return [inputs[0], splitOptions(row)];
    case 'merge':
      return [...inputs, mergeOptions(row)];
    default:
      throw new Error(`${rowId(row)}: no arguments for client.${method}; add them, never skip the row`);
  }
}

interface Invocation {
  /** The object the YAML-named method is read from and called on. */
  readonly receiver: object;
  readonly method: string;
  readonly args: readonly unknown[];
  /** The stubs the call was given, in the order the SDK uploads them (base before overlay). */
  readonly uploads: readonly Blob[];
}

function invocation(client: ErgonomicClient, row: Row, entry: Entry): Invocation {
  const stub = (): Blob => new Blob([STUB_BYTES], { type: groupMime(row) ?? '' });
  switch (entry.kind) {
    case 'file-first': {
      if (entry.via === 'files') {
        const inputs = [stub(), stub()];
        return { receiver: client.files(inputs), method: entry.step, args: fileFirstArgs(client, row, entry.step).args, uploads: inputs };
      }
      const base = stub();
      const { args, overlays } = fileFirstArgs(client, row, entry.step);
      return { receiver: client.file(base), method: entry.step, args, uploads: [base, ...overlays] };
    }
    case 'client': {
      const inputs = entry.method === 'merge' ? [stub(), stub()] : [stub()];
      return { receiver: client, method: entry.method, args: clientArgs(row, entry.method, inputs), uploads: inputs };
    }
    case 'generic': {
      const input = stub();
      return { receiver: client, method: 'operation', args: [row.operation, input], uploads: [input] };
    }
  }
}

type UploadResult = Awaited<ReturnType<GislClient['uploadFile']>>;
type CreateResult = Awaited<ReturnType<GislClient['createWorkflow']>>;

interface Exercised {
  readonly payload: WorkflowCreatePayload;
  /** The stubs the call was given, in upload order. */
  readonly stubs: readonly Blob[];
  /** What `uploadFile` received, in call order. */
  readonly uploaded: readonly unknown[];
  /** The distinct file id `uploadFile` returned for each call, in call order. */
  readonly fileIds: readonly string[];
}

/**
 * Call `entry` on a real `create()` client by its YAML name, `submit()` it, and
 * return the ONE workflow-create payload. Never swallows: a local refusal or a
 * request past the fence rejects, and fails the row.
 */
async function exercise(row: Row, entry: Entry): Promise<Exercised> {
  vi.restoreAllMocks();
  const fileIds: string[] = [];
  const uploadSpy = vi.spyOn(GislClient.prototype, 'uploadFile').mockImplementation(async (file) => {
    const fileId = `file_${fileIds.length + 1}`;
    fileIds.push(fileId);
    const blob = file as Blob;
    return { fileId, contentType: blob.type, sizeBytes: blob.size } as unknown as UploadResult;
  });
  vi.spyOn(GislClient.prototype, 'maybeWaitForVideoProbe').mockResolvedValue(undefined);
  const createSpy = vi
    .spyOn(GislClient.prototype, 'createWorkflow')
    .mockResolvedValue({ workflowId: 'wf_parity', status: 'pending' } as unknown as CreateResult);

  const client = await create({ apiKey: 'k', baseUrl: API_BASE_URL });
  const { receiver, method, args, uploads } = invocation(client, row, entry);
  const target: unknown = Reflect.get(receiver, method);
  expect(typeof target, `${entryLabel(entry)} is a function at runtime`).toBe('function');
  const builder = Reflect.apply(target as (...a: unknown[]) => unknown, receiver, args) as {
    submit(): Promise<unknown>;
  };
  await builder.submit();

  expect(createSpy).toHaveBeenCalledTimes(1);
  return {
    payload: createSpy.mock.calls[0][0],
    stubs: uploads,
    uploaded: uploadSpy.mock.calls.map((call) => call[0]),
    fileIds,
  };
}

/** Every operation the payload sends, across all jobs. */
function operationsOf(payload: WorkflowCreatePayload): OperationDef[] {
  return payload.jobs.flatMap((job) => job.operations);
}

/** The upload file ids the payload's job sources reference, in job order. */
function uploadSourceIds(payload: WorkflowCreatePayload): string[] {
  return payload.jobs.flatMap((job) => (job.source?.type === 'upload' ? [job.source.file_id] : []));
}

/**
 * Null when `operations` is the binding the row claims, else why not: exactly
 * one operation other than the passthrough source ops, and it is `operation`.
 * The passthrough row itself must send exactly one bare passthrough.
 */
function bindingFailure(operations: readonly OperationDef[], operation: string): string | null {
  const types: string[] = operations.map((op) => op.type);
  if (operation === PASSTHROUGH) {
    const bare =
      operations.length === 1 && types[0] === PASSTHROUGH && Object.keys(operations[0].options ?? {}).length === 0;
    return bare ? null : `expected exactly one bare passthrough, got ${JSON.stringify(operations)}`;
  }
  const lowered = types.filter((type) => type !== PASSTHROUGH);
  if (lowered.length !== 1) return `expected exactly one non-passthrough operation, got [${lowered.join(', ')}]`;
  return lowered[0] === operation ? null : `lowered to ${lowered[0]}, the row says ${operation}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('operation parity: docs/parity/operations.yaml ts column on the real surface', () => {
  let fenceCalls: string[] = [];

  beforeEach(() => {
    fenceCalls = [];
    // A fence, not a stub: every transport call this suite expects is spied on
    // the prototype, so any request that gets here is one it did not expect.
    vi.stubGlobal('fetch', async (input: unknown): Promise<never> => {
      fenceCalls.push(String(input));
      throw new Error(`fetch fence: ${String(input)} would have left the test`);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('every required row has a reachable TS entry, and every entry kind is exercised', () => {
    expect(REQUIRED_ROWS.length).toBeGreaterThanOrEqual(MIN_REQUIRED_ROWS);
    expect(REQUIRED_ROWS.filter((row) => row.entries.length === 0).map(rowId)).toEqual([]);
    for (const kind of ['file-first', 'client', 'generic'] as const) {
      expect(CASES.filter((c) => c.entry.kind === kind).length, kind).toBeGreaterThan(0);
    }
  });

  describe('(1) existence on the built surface', () => {
    it('every (type, member) a required row names is declared on every built types entrypoint', () => {
      const surface = builtSurface();
      expect([...surface.keys()].map(relativeEntry)).toEqual(
        expect.arrayContaining(['dist/index.d.ts', 'dist/index.browser.d.ts']),
      );
      expect(existenceFailures(surface, REQUIRED_MEMBERS)).toEqual([]);
    });
  });

  describe('(2) binding: each reachable entry sends its row operation', () => {
    it.each(CASES)('$id', async ({ row, entry }) => {
      const run = await exercise(row, entry);

      expect(bindingFailure(operationsOf(run.payload), row.operation)).toBeNull();
      // Upload identity: exactly the test's stubs, in order, and the payload is built over them.
      expect(run.uploaded).toHaveLength(run.stubs.length);
      run.stubs.forEach((stub, i) => expect(run.uploaded[i], `upload ${i}`).toBe(stub));
      expect((run.uploaded[0] as Blob).type, 'the first upload carries the group MIME').toBe(groupMime(row) ?? '');
      expect(uploadSourceIds(run.payload)).toEqual(run.fileIds);
      expect(fenceCalls).toEqual([]);
    });
  });

  describe('(3) negative controls through the same checkers', () => {
    it('existence: a misspelt step, and a GislClient-only name asked of ErgonomicClient, are reported', () => {
      const surface = builtSurface();
      const entries = [...surface.keys()].map(relativeEntry);

      // Positive control: the real step IS found, so the miss below is the spelling.
      expect(existenceFailures(surface, [{ type: 'Recipe', name: 'compress' }])).toEqual([]);
      expect(existenceFailures(surface, [{ type: 'Recipe', name: 'compres' }])).toEqual(
        entries.map((entry) => `${entry}: Recipe declares no public compres`),
      );

      // uploadFile IS public on GislClient, the other half of the intersection,
      // so the miss below is the reader taking only the type-literal half.
      for (const entry of surface.keys()) expect(publicClassMethods(entry, 'GislClient').has('uploadFile')).toBe(true);
      expect(existenceFailures(surface, [{ type: 'ErgonomicClient', name: 'uploadFile' }])).toEqual(
        entries.map((entry) => `${entry}: ErgonomicClient declares no public uploadFile`),
      );
    });

    it('binding: the compress/image row bound to thumbnail is a type mismatch; bound as the YAML says it passes', async () => {
      const row = requiredRow('compress', 'image');
      const real = row.entries.find((entry) => entry.kind === 'file-first');
      if (real?.kind !== 'file-first') throw new Error('compress/image has no file-first entry');

      const right = await exercise(row, real);
      expect(bindingFailure(operationsOf(right.payload), row.operation)).toBeNull();

      const wrong = await exercise(row, { ...real, step: 'thumbnail' });
      expect(bindingFailure(operationsOf(wrong.payload), row.operation)).toBe(
        'lowered to thumbnail, the row says compress',
      );
    });
  });
});
