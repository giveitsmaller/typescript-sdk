/**
 * iOcpCt6L — drift gate for the hand-written SSE wire interfaces
 * (`src/sse-wire.ts`).
 *
 * Two halves, and both are needed:
 *
 * 1. COMPILE TIME (`npm run check:tests`): each `wireKeys<T>()(...)` call below
 *    must list EXACTLY T's required keys and EXACTLY its optional keys. A key
 *    missing from either list, or listed on the wrong side, is a tsc error.
 *    That ties these lists to the interfaces.
 * 2. RUN TIME (vitest): each list is compared with the OpenAPI schema it
 *    mirrors in the VENDORED spec (`generated/typescript/openapi/api.yaml`,
 *    rewritten by every re-vendor). A contract that adds, removes or renames a
 *    property, or flips one between required and optional, fails here on the
 *    re-vendor that brings it in. Literal sets (status enums, `result_kind`,
 *    the `status` consts) are compared the same way.
 *
 * Neither half alone is a gate: (1) alone cannot see the contract, and (2)
 * alone compares the spec with a list nobody is forced to keep equal to the
 * interface.
 *
 * Reads the vendored spec (not the contracts sibling), so it runs anywhere the
 * repo is checked out, worktrees included.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  SseOperationProgressWire,
  SseOperationCompletedWire,
  SseSingleOutputCompletionWire,
  SseMultiOutputCompletionWire,
  SseMultiOutputResultEntryWire,
  SseOperationResultMetricsWire,
  SseMultiOutputCompletionMetricsWire,
  SseOperationResultMetadataWire,
  SseOperationFailedWire,
  SseJobCompletedWire,
  SseJobFailedWire,
  SseWorkflowTerminalWire,
} from '../../src/sse-wire.js';
import { GENERATED_SPEC_PATH, SDKS_REPO_ROOT } from './_contract-paths.js';

// ---------------------------------------------------------------------------
// Compile-time half
// ---------------------------------------------------------------------------

type RequiredKeysOf<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
type OptionalKeysOf<T> = Exclude<keyof T, RequiredKeysOf<T>>;
/** `L` when it names every member of `All`; otherwise a type no tuple satisfies. */
type Exhaustive<All, L extends readonly PropertyKey[]> = [All] extends [L[number]]
  ? L
  : { readonly missingKeys: Exclude<All, L[number]> };

interface WireKeyDescriptor {
  /** JSON pointer into the spec, e.g. `#/components/schemas/OperationResult/properties/metrics`. */
  readonly schema: string;
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

function wireKeys<T>() {
  return <const R extends readonly RequiredKeysOf<T>[], const O extends readonly OptionalKeysOf<T>[]>(
    schema: string,
    required: R & Exhaustive<RequiredKeysOf<T>, R>,
    optional: O & Exhaustive<OptionalKeysOf<T>, O>,
  ): WireKeyDescriptor => ({
    schema,
    required: required as readonly PropertyKey[] as readonly string[],
    optional: optional as readonly PropertyKey[] as readonly string[],
  });
}

/** Same exhaustiveness trick for a union of string literals. */
function wireLiterals<T extends string>() {
  return <const L extends readonly T[]>(schema: string, values: L & Exhaustive<T, L>) => ({
    schema,
    values: values as readonly string[],
  });
}

const S = '#/components/schemas';

/** Keyed by interface name; the coverage test below demands one per `export interface` in sse-wire.ts. */
const WIRE_KEYS: Record<string, WireKeyDescriptor> = {
  SseOperationProgressWire: wireKeys<SseOperationProgressWire>()(
    `${S}/SseOperationProgressData`,
    ['job_ref', 'operation_id', 'type', 'progress'],
    ['status', 'stage', 'phase_input_index', 'phase_total_inputs'],
  ),
  SseOperationCompletedWire: wireKeys<SseOperationCompletedWire>()(
    `${S}/SseOperationCompletedData`,
    ['job_ref', 'operation_id', 'type', 'status', 'progress'],
    ['result', 'result_metadata'],
  ),
  SseSingleOutputCompletionWire: wireKeys<SseSingleOutputCompletionWire>()(
    `${S}/SseSingleOutputCompletion`,
    ['result_kind', 'download_url', 'size_bytes'],
    ['mime_type', 'export_key', 'metrics'],
  ),
  SseOperationResultMetricsWire: wireKeys<SseOperationResultMetricsWire>()(
    `${S}/OperationResult/properties/metrics`,
    [],
    [
      'compression_ratio',
      'chosen_quality',
      'target_size_met',
      'measured_quality',
      'quality_metric',
      'duration_ms',
      're_encode_decision',
      're_encode_reason',
    ],
  ),
  SseMultiOutputCompletionWire: wireKeys<SseMultiOutputCompletionWire>()(
    `${S}/SseMultiOutputCompletionWithKind`,
    ['result_kind', 'outputs', 'total_output_size_bytes'],
    ['metrics'],
  ),
  SseMultiOutputResultEntryWire: wireKeys<SseMultiOutputResultEntryWire>()(
    `${S}/SseMultiOutputResultEntry`,
    ['download_url', 'size_bytes'],
    ['page_index', 'position'],
  ),
  SseMultiOutputCompletionMetricsWire: wireKeys<SseMultiOutputCompletionMetricsWire>()(
    `${S}/SseMultiOutputCompletion/properties/metrics`,
    [],
    ['compression_ratio', 'duration_ms'],
  ),
  SseOperationResultMetadataWire: wireKeys<SseOperationResultMetadataWire>()(
    `${S}/OperationResultMetadata`,
    [],
    ['watermark_id', 'already_optimal', 'already_optimal_kind', 'estimated_saving_pct'],
  ),
  SseOperationFailedWire: wireKeys<SseOperationFailedWire>()(
    `${S}/SseOperationFailedData`,
    ['job_ref', 'operation_id', 'type', 'status', 'error_code', 'error_message'],
    ['message_key', 'message_params'],
  ),
  SseJobCompletedWire: wireKeys<SseJobCompletedWire>()(
    `${S}/SseJobCompletedData`,
    ['job_ref', 'job_id', 'status'],
    [],
  ),
  SseJobFailedWire: wireKeys<SseJobFailedWire>()(
    `${S}/SseJobFailedData`,
    ['job_ref', 'job_id', 'status'],
    [],
  ),
  SseWorkflowTerminalWire: wireKeys<SseWorkflowTerminalWire>()(
    `${S}/SseWorkflowTerminalData`,
    ['workflow_id', 'status'],
    ['reason'],
  ),
};

const WIRE_LITERALS = [
  wireLiterals<NonNullable<SseOperationProgressWire['status']>>()(
    `${S}/SseOperationProgressData/properties/status`,
    ['started', 'downloading', 'probing', 'decoding', 'processing', 'encoding', 'uploading'],
  ),
  wireLiterals<SseWorkflowTerminalWire['status']>()(
    `${S}/SseWorkflowTerminalData/properties/status`,
    ['completed', 'failed', 'partially_failed'],
  ),
  wireLiterals<SseOperationCompletedWire['status']>()(`${S}/SseOperationCompletedData/properties/status`, ['completed']),
  wireLiterals<SseOperationFailedWire['status']>()(`${S}/SseOperationFailedData/properties/status`, ['failed']),
  wireLiterals<SseJobCompletedWire['status']>()(`${S}/SseJobCompletedData/properties/status`, ['completed']),
  wireLiterals<SseJobFailedWire['status']>()(`${S}/SseJobFailedData/properties/status`, ['failed']),
  wireLiterals<SseSingleOutputCompletionWire['result_kind']>()(
    `${S}/SseSingleOutputCompletion/allOf/2/properties/result_kind`,
    ['single'],
  ),
  wireLiterals<SseMultiOutputCompletionWire['result_kind']>()(
    `${S}/SseMultiOutputCompletionWithKind/allOf/2/properties/result_kind`,
    ['multi'],
  ),
  wireLiterals<NonNullable<SseOperationResultMetadataWire['already_optimal_kind']>>()(
    `${S}/OperationResultMetadata/properties/already_optimal_kind`,
    ['not_smaller'],
  ),
];

// ---------------------------------------------------------------------------
// Run-time half
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function pointer(doc: Json, ptr: string): Json {
  if (!ptr.startsWith('#/')) throw new Error(`not a local pointer: ${ptr}`);
  let node: unknown = doc;
  for (const raw of ptr.slice(2).split('/')) {
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object' || !(seg in (node as Json))) {
      throw new Error(`pointer ${ptr} does not resolve at '${seg}'`);
    }
    node = (node as Json)[seg];
  }
  return node as Json;
}

function deref(doc: Json, schema: Json): Json {
  let current = schema;
  const seen = new Set<string>();
  while (typeof current.$ref === 'string') {
    if (seen.has(current.$ref)) throw new Error(`$ref cycle at ${current.$ref}`);
    seen.add(current.$ref);
    current = pointer(doc, current.$ref);
  }
  return current;
}

/**
 * Property names + required set of an object schema, folding `allOf` (the
 * branch wrappers are `allOf` compositions). `oneOf` branches are NOT folded:
 * on `SseMultiOutputResultEntry` they only narrow which of the declared
 * properties is present, and the declared properties are the wire keys.
 */
function schemaKeys(doc: Json, schema: Json): { properties: Set<string>; required: Set<string> } {
  const resolved = deref(doc, schema);
  const properties = new Set<string>(Object.keys((resolved.properties as Json | undefined) ?? {}));
  const required = new Set<string>((resolved.required as string[] | undefined) ?? []);
  for (const part of (resolved.allOf as Json[] | undefined) ?? []) {
    const sub = schemaKeys(doc, part);
    sub.properties.forEach((p) => properties.add(p));
    sub.required.forEach((r) => required.add(r));
  }
  return { properties, required };
}

/** Every disagreement between a descriptor and the schema's keys; empty means in sync. */
function diffWireKeys(
  descriptor: Pick<WireKeyDescriptor, 'required' | 'optional'>,
  spec: { properties: Set<string>; required: Set<string> },
): string[] {
  const problems: string[] = [];
  const declared = new Set([...descriptor.required, ...descriptor.optional]);
  for (const p of spec.properties) {
    if (!declared.has(p)) problems.push(`contract property '${p}' is missing from the wire interface`);
  }
  for (const k of declared) {
    if (!spec.properties.has(k)) problems.push(`wire key '${k}' is not a contract property`);
  }
  for (const k of descriptor.required) {
    if (spec.properties.has(k) && !spec.required.has(k)) problems.push(`'${k}' is required in the wire interface but optional in the contract`);
  }
  for (const k of descriptor.optional) {
    if (spec.required.has(k)) problems.push(`'${k}' is optional in the wire interface but required in the contract`);
  }
  for (const r of spec.required) {
    if (!spec.properties.has(r)) problems.push(`contract requires '${r}' but does not declare it as a property`);
  }
  return problems;
}

function schemaLiterals(doc: Json, ptr: string): string[] {
  const schema = deref(doc, pointer(doc, ptr));
  if (Array.isArray(schema.enum)) return schema.enum as string[];
  if ('const' in schema) return [schema.const as string];
  throw new Error(`${ptr} has neither enum nor const`);
}

let specDoc: Json | null = null;
function loadSpec(): Json {
  specDoc ??= parseYaml(readFileSync(GENERATED_SPEC_PATH, 'utf8')) as Json;
  return specDoc;
}

describe('SSE wire interfaces match the vendored contract (iOcpCt6L)', () => {
  for (const [name, descriptor] of Object.entries(WIRE_KEYS)) {
    it(`${name} has exactly the keys of ${descriptor.schema}`, () => {
      const doc = loadSpec();
      const spec = schemaKeys(doc, pointer(doc, descriptor.schema));
      expect(spec.properties.size).toBeGreaterThan(0);
      expect(diffWireKeys(descriptor, spec)).toEqual([]);
    });
  }

  for (const { schema, values } of WIRE_LITERALS) {
    it(`literal set of ${schema} matches the contract`, () => {
      expect([...values].sort()).toEqual([...schemaLiterals(loadSpec(), schema)].sort());
    });
  }

  it('every exported interface in src/sse-wire.ts is gated here', () => {
    const src = readFileSync(resolve(SDKS_REPO_ROOT, 'packages/typescript/src/sse-wire.ts'), 'utf8');
    const exported = [...src.matchAll(/^export interface (\w+)/gm)].map((m) => m[1]).sort();
    expect(exported.length).toBeGreaterThan(0);
    expect(exported).toEqual(Object.keys(WIRE_KEYS).sort());
  });

  it('the SseOperationCompletionResult discriminator is exactly single | multi', () => {
    expect([...schemaLiterals(loadSpec(), `${S}/SseOperationCompletionResult/properties/result_kind`)].sort()).toEqual([
      'multi',
      'single',
    ]);
  });

  it('the contract SseEventType enum is exactly the eight named GislSseEvent arms', () => {
    // The compile-time twin lives in src/sse.ts against the generated
    // SseEventType; this pins the same set against the vendored spec.
    expect([...schemaLiterals(loadSpec(), `${S}/SseEventType`)].sort()).toEqual(
      [
        'job.completed',
        'job.failed',
        'operation.completed',
        'operation.failed',
        'operation.progress',
        'workflow.completed',
        'workflow.failed',
        'workflow.partially_failed',
      ].sort(),
    );
  });
});

describe('the drift comparison can fail (negative controls)', () => {
  it('the compile-time half rejects an incomplete or mis-sided key list', () => {
    // These lines are checked by `npm run check:tests`: if either stopped
    // being an error, the unused @ts-expect-error itself fails tsc.
    // @ts-expect-error — `status` (required) is missing.
    wireKeys<SseJobFailedWire>()('x', ['job_ref', 'job_id'], []);
    // @ts-expect-error — `reason` is optional, listed as required.
    wireKeys<SseWorkflowTerminalWire>()('x', ['workflow_id', 'status', 'reason'], []);
    // @ts-expect-error — a literal set missing `partially_failed`.
    wireLiterals<SseWorkflowTerminalWire['status']>()('x', ['completed', 'failed']);
  });

  const descriptor = { required: ['a', 'b'], optional: ['c'] };
  const inSync = { properties: new Set(['a', 'b', 'c']), required: new Set(['a', 'b']) };

  it('reports nothing for an in-sync pair (positive control)', () => {
    expect(diffWireKeys(descriptor, inSync)).toEqual([]);
  });

  it('fails when the contract ADDS a property', () => {
    const spec = { properties: new Set(['a', 'b', 'c', 'd']), required: new Set(['a', 'b']) };
    expect(diffWireKeys(descriptor, spec)).toEqual(["contract property 'd' is missing from the wire interface"]);
  });

  it('fails when the contract REMOVES a property', () => {
    const spec = { properties: new Set(['a', 'b']), required: new Set(['a', 'b']) };
    expect(diffWireKeys(descriptor, spec)).toEqual(["wire key 'c' is not a contract property"]);
  });

  it('fails when the contract RENAMES a property', () => {
    const spec = { properties: new Set(['a', 'b', 'c_renamed']), required: new Set(['a', 'b']) };
    expect(diffWireKeys(descriptor, spec)).toEqual([
      "contract property 'c_renamed' is missing from the wire interface",
      "wire key 'c' is not a contract property",
    ]);
  });

  it('fails when a key flips between required and optional, either way', () => {
    const spec = { properties: new Set(['a', 'b', 'c']), required: new Set(['a', 'c']) };
    expect(diffWireKeys(descriptor, spec)).toEqual([
      "'b' is required in the wire interface but optional in the contract",
      "'c' is optional in the wire interface but required in the contract",
    ]);
  });

  it('folds allOf and fails a mutated real schema (end-to-end through the resolver)', () => {
    // Take the real single-output branch, add a property to its OperationResult
    // base in a COPY of the spec, and check the real descriptor now fails.
    const doc = structuredClone(loadSpec());
    const base = pointer(doc, `${S}/OperationResult`);
    (base.properties as Json).brand_new_key = { type: 'string' };
    const spec = schemaKeys(doc, pointer(doc, WIRE_KEYS.SseSingleOutputCompletionWire.schema));
    expect(diffWireKeys(WIRE_KEYS.SseSingleOutputCompletionWire, spec)).toEqual([
      "contract property 'brand_new_key' is missing from the wire interface",
    ]);
  });
});
