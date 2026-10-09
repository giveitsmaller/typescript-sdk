/**
 * F9UUicuO — `GET /api/operations/schema` capability conditions must survive
 * deserialisation.
 *
 * typescript-fetch dispatches a `oneOf` by calling each variant's `instanceOf`
 * on the RAW wire JSON, but `instanceOf` tests the TypeScript property names.
 * Wherever the two differ (`in` -> `_in`, `same_as_input` -> `sameAsInput`,
 * `from_option` -> `fromOption`) no variant matched and the dispatcher returned
 * `{}`: every `{field, in}` leaf of `capabilities.*.option_conflicts[*].when`
 * (all the `output_container` rules among them) and every `produces` other than
 * `fixed` came back empty. scripts/generate.py now rewrites those dispatch
 * checks to test the wire keys.
 *
 * The round-trip test feeds the SHIPPED operation-capabilities sidecar through
 * the generated deserialiser and back, so a new operator, or a new renamed
 * field, is covered the moment the contract ships it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  CapabilityConditionFromJSON,
  CapabilityProducesFromJSON,
  CodegenSourceJobSourceFromJSON,
  OperationsSchemaResponseFromJSON,
  OperationsSchemaResponseToJSON,
} from '@giveitsmaller/contracts/openapi';

const require = createRequire(import.meta.url);
const sidecar = JSON.parse(
  readFileSync(
    require.resolve('@giveitsmaller/contracts/operation-capabilities/operation-capabilities.json'),
    'utf8',
  ),
) as { operations: Record<string, Record<string, unknown>> };

type Rule = { constraint_id: string; when: unknown };

function leafForms(node: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(node)) {
    node.forEach((n) => leafForms(n, into));
  } else if (node !== null && typeof node === 'object') {
    into.add(Object.keys(node).sort().join('+'));
    Object.values(node).forEach((v) => leafForms(v, into));
  }
  return into;
}

function rules(ops: Record<string, Record<string, unknown>>): Rule[] {
  return Object.values(ops).flatMap((op) =>
    (['option_conflicts', 'excludes', 'requires'] as const).flatMap((k) => (op[k] as Rule[] | undefined) ?? []),
  );
}

function schemaBody(capabilities: unknown): Record<string, unknown> {
  return {
    schema_version: '2.0.0',
    capabilities_version: '1',
    generated_at: '2026-10-07T00:00:00Z',
    operations: {},
    capabilities,
  };
}

describe('capability conditions survive OperationsSchemaResponseFromJSON (F9UUicuO)', () => {
  it('positive control: the shipped sidecar exercises every condition form and every produces form', () => {
    const forms = new Set<string>();
    rules(sidecar.operations).forEach((r) => leafForms(r.when, forms));
    // `opSelected` left the shipped sidecar at contracts v2.227.0; its decode path stays
    // covered by the synthetic 'decodes every operator form' case below.
    for (const form of ['all', 'any', 'not', 'equals+field', 'field+in', 'field+isSet', 'field+numericZero']) {
      expect(forms, `sidecar no longer carries a ${form} node`).toContain(form);
    }
    const produces = new Set(
      Object.values(sidecar.operations).map((op) => Object.keys((op.produces as object | undefined) ?? {}).join()),
    );
    for (const form of ['same_as_input', 'from_option', 'fixed']) {
      expect(produces, `sidecar no longer carries produces.${form}`).toContain(form);
    }
  });

  it('every shipped capability round-trips FromJSON -> ToJSON with nothing lost', () => {
    const decoded = OperationsSchemaResponseFromJSON(schemaBody(sidecar.operations));
    const reencoded = OperationsSchemaResponseToJSON(decoded) as { capabilities: unknown };
    // JSON round-trip drops the `undefined` optionals ToJSON writes, so the
    // comparison is exact on everything that is present.
    expect(JSON.parse(JSON.stringify(reencoded.capabilities))).toEqual(sidecar.operations);
  });

  it('no decoded condition node is the empty object the broken dispatch returned', () => {
    const decoded = OperationsSchemaResponseFromJSON(schemaBody(sidecar.operations));
    const empties: string[] = [];
    const visit = (node: unknown, where: string): void => {
      if (Array.isArray(node)) node.forEach((n, i) => visit(n, `${where}[${i}]`));
      else if (node !== null && typeof node === 'object') {
        if (Object.keys(node).length === 0) empties.push(where);
        Object.entries(node).forEach(([k, v]) => visit(v, `${where}.${k}`));
      }
    };
    for (const [op, cap] of Object.entries(decoded.capabilities ?? {})) {
      for (const k of ['optionConflicts', 'excludes', 'requires'] as const) {
        (cap[k] ?? []).forEach((r, i) => visit(r.when, `${op}.${k}[${i}].when`));
      }
    }
    expect(empties).toEqual([]);
  });

  it('the frontend-reported rule: an `in` leaf keeps its values, under the generated `_in` name', () => {
    expect(CapabilityConditionFromJSON({ field: 'compress.codec', in: ['h265', 'vp9', 'av1'] })).toEqual({
      field: 'compress.codec',
      _in: ['h265', 'vp9', 'av1'],
    });
  });

  it('decodes every operator form', () => {
    const decoded = CapabilityConditionFromJSON({
      all: [
        { field: 'output_container', in: ['webm'] },
        { field: 'compress.codec', equals: 'h265' },
        { field: 'compress.codec', isSet: true },
        { field: 'text_watermark.margin_x', numericZero: true },
        { opSelected: 'compress' },
        { any: [{ not: { field: 'compress.lossless', equals: false } }] },
      ],
    });
    expect(decoded).toEqual({
      all: [
        { field: 'output_container', _in: ['webm'] },
        { field: 'compress.codec', equals: 'h265' },
        { field: 'compress.codec', isSet: true },
        { field: 'text_watermark.margin_x', numericZero: true },
        { opSelected: 'compress' },
        { any: [{ not: { field: 'compress.lossless', equals: false } }] },
      ],
    });
  });

  it('`equals: null` still selects the equals form (present-but-null is a value)', () => {
    expect(CapabilityConditionFromJSON({ field: 'f', equals: null })).toEqual({ field: 'f', equals: null });
  });

  it('a node matching no form still decodes to {} (unchanged fallback)', () => {
    expect(CapabilityConditionFromJSON({ unknown_operator: 1 })).toEqual({});
  });

  it('produces: same_as_input and from_option decode (snake_case wire keys)', () => {
    expect(CapabilityProducesFromJSON({ same_as_input: true })).toEqual({ sameAsInput: true });
    expect(CapabilityProducesFromJSON({ from_option: 'output_format' })).toEqual({ fromOption: 'output_format' });
    expect(CapabilityProducesFromJSON({ fixed: 'mp4' })).toEqual({ fixed: 'mp4' });
  });

  it('the same dispatch fix reaches the other affected oneOf model (job source)', () => {
    expect(CodegenSourceJobSourceFromJSON({ type: 'connection', connection_id: 'c1', path: '/a.jpg' })).toEqual({
      type: 'connection',
      connectionId: 'c1',
      path: '/a.jpg',
    });
    expect(CodegenSourceJobSourceFromJSON({ type: 'external_import', external_source_id: 'x1' })).toEqual({
      type: 'external_import',
      externalSourceId: 'x1',
    });
  });
});
