/**
 * Schema-level contract drift guard: SDK request-body field names must agree
 * with the OpenAPI spec. Complements `contract-drift.test.ts` (which checks
 * URL paths only). Motivation: the `file_id` -> `upload_id` drift on
 * `/multipart/complete` passed every path-only gate (ticket 2m6jtcvX).
 *
 * Site-by-site strategy (see ticket X1Y05dXq):
 *
 * (a) Single-upload and multipart-initiate are `multipart/form-data` with no
 *     generated ToJSON helper — covered here at runtime by comparing
 *     `FormData.append()` string literals in client.ts against the spec's
 *     schema properties for each endpoint.
 *
 * (b) Workflow CREATE ships the SDK's hand-written `WorkflowCreatePayload`
 *     (types.ts) straight through as the JSON body. The generated
 *     `JobDefinition` is `any` and its `ToJSON` returns `{}`, so routing
 *     through `WorkflowCreateRequestToJSON` would silently wipe the jobs
 *     array — approach B is unusable here. Runtime checks here assert the
 *     spec's properties ⇔ `WORKFLOW_CREATE_PAYLOAD_KEYS` (the SDK allow-list
 *     from `types.ts`). The SDK-side invariant (`keyof WorkflowCreatePayload`
 *     ⇔ `WORKFLOW_CREATE_PAYLOAD_KEYS`) is a compile-time check in `types.ts`
 *     itself — must live in `src/` because `tsconfig.json` excludes `tests/`.
 *
 * (c) Multipart COMPLETE was refactored to build a typed
 *     `MultipartCompleteRequest` and serialise via
 *     `MultipartCompleteRequestToJSON` (client.ts `multipartUpload`). tsc is
 *     now the field-name drift gate for that site. The assertion here is a
 *     regression guard against someone reverting that refactor back to a
 *     string-literal body.
 *
 * Spec source is `generated/typescript/openapi/api.yaml` (per the ticket) —
 * the snapshot the SDK was last generated against. This is deliberately
 * different from `contract-drift.test.ts`, which reads the contracts repo.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import ts from 'typescript';
import { WORKFLOW_CREATE_PAYLOAD_KEYS } from '../../src/types.js';
import { CLIENT_SRC_PATH, GENERATED_SPEC_PATH } from './_contract-paths.js';

interface OpenApiDoc {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, OpenApiSchema> };
}

interface OpenApiOperation {
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: OpenApiSchemaRef }>;
  };
}

type OpenApiSchemaRef = OpenApiSchema | { $ref: string };

interface OpenApiSchema {
  // OpenAPI 3.1 allows `type: [string, "null"]` — widen accordingly.
  type?: string | string[];
  required?: string[];
  properties?: Record<string, unknown>;
  $ref?: string;
}

function loadSpec(): OpenApiDoc {
  if (_specDoc === null) {
    _specDoc = parseYaml(readFileSync(GENERATED_SPEC_PATH, 'utf8')) as OpenApiDoc;
  }
  return _specDoc;
}

function decodeJsonPointerSegment(segment: string): string {
  // RFC 6901: '~1' -> '/', '~0' -> '~'. Decode '~1' first so the '~0'
  // replacement doesn't double-decode a literal '~'.
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveRef(doc: OpenApiDoc, ref: string): OpenApiSchema {
  // Only supports local refs like '#/components/schemas/Foo'. Segments are
  // JSON-pointer-encoded per RFC 6901.
  const parts = ref.replace(/^#\//, '').split('/').map(decodeJsonPointerSegment);
  let cursor: unknown = doc;
  for (const p of parts) {
    if (typeof cursor !== 'object' || cursor === null) {
      throw new Error(`Cannot resolve $ref ${ref} — segment before ${p} is not an object`);
    }
    cursor = (cursor as Record<string, unknown>)[p];
    if (cursor === undefined) {
      throw new Error(`Cannot resolve $ref ${ref} — missing segment ${p}`);
    }
  }
  return cursor as OpenApiSchema;
}

const UNSUPPORTED_COMPOSITION_KEYS = ['anyOf', 'oneOf', 'not'] as const;

function resolveSchema(doc: OpenApiDoc, schema: OpenApiSchemaRef): OpenApiSchema {
  // Follow $ref hops until we land on a concrete schema object. Bounded at
  // MAX_HOPS to prevent infinite loops on a malformed spec with circular refs.
  // Bound is generous (32) so legitimate deep references aren't rejected.
  const MAX_HOPS = 32;
  let current: unknown = schema;
  const visited: string[] = [];
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (typeof current !== 'object' || current === null) {
      throw new Error(`resolveSchema: expected object, got ${typeof current}`);
    }
    const ref = (current as { $ref?: unknown }).$ref;
    if (typeof ref !== 'string') {
      // Handle allOf by merging object branches into the current schema — a
      // pragmatic minimum that matches how openapi-generator composes types.
      // anyOf/oneOf/not describe choices or negations with no single
      // "merged" properties shape; surface those with a clear error.
      const obj = current as Record<string, unknown>;
      if (Array.isArray(obj.allOf)) {
        const merged = mergeAllOf(doc, obj);
        return merged;
      }
      const unsupported = UNSUPPORTED_COMPOSITION_KEYS.find(k => k in obj);
      if (unsupported !== undefined) {
        throw new Error(
          `resolveSchema: unsupported composition keyword '${unsupported}' at ${visited.join(' -> ') || '<root>'} — ` +
            `drift helpers don't model choice/negation composition. Extend resolveSchema if a checked requestBody adopts it.`,
        );
      }
      return current as OpenApiSchema;
    }
    visited.push(ref);
    current = resolveRef(doc, ref);
  }
  throw new Error(
    `resolveSchema: exceeded ${MAX_HOPS} $ref hops — likely a circular reference. Trace: ${visited.join(' -> ')}`,
  );
}

function mergeAllOf(doc: OpenApiDoc, schema: Record<string, unknown>): OpenApiSchema {
  // Merge the current schema's own fields with every resolved allOf branch.
  // Properties are shallow-merged; `required` arrays are unioned.
  const branches = (schema.allOf as unknown[]).map(b => resolveSchema(doc, b as OpenApiSchemaRef));
  const mergedProperties: Record<string, unknown> = { ...((schema.properties as Record<string, unknown>) ?? {}) };
  const mergedRequired = new Set<string>((schema.required as string[] | undefined) ?? []);
  for (const b of branches) {
    if (b.properties) Object.assign(mergedProperties, b.properties);
    for (const r of b.required ?? []) mergedRequired.add(r);
  }
  return {
    type: 'object',
    properties: mergedProperties,
    required: [...mergedRequired],
  };
}

function getRequestBodySchema(
  doc: OpenApiDoc,
  path: string,
  method: string,
  mediaType: string,
): OpenApiSchema {
  const op = doc.paths?.[path]?.[method];
  if (!op) throw new Error(`Spec has no ${method.toUpperCase()} ${path}`);
  const content = op.requestBody?.content?.[mediaType];
  if (!content?.schema) {
    throw new Error(`Spec ${method.toUpperCase()} ${path} has no ${mediaType} requestBody schema`);
  }
  return resolveSchema(doc, content.schema);
}

// ---------------------------------------------------------------------------
// AST-based scanner for FormData-body drift checks
//
// Uses the TypeScript compiler API to locate method declarations and walk
// their bodies, avoiding brittle regex / brace-counting pitfalls: callback
// params in signatures, braces inside strings / template literals, commented
// `.append()` calls, or call sites preceding the method definition.
// ---------------------------------------------------------------------------

// Module-scope caches — reading client.ts and parsing its AST is non-trivial
// and every `it` re-uses the same source. Spec YAML parsing is similarly
// memoised.
let _clientSourceFile: ts.SourceFile | null = null;
let _specDoc: OpenApiDoc | null = null;

function parseClientSource(): ts.SourceFile {
  if (_clientSourceFile === null) {
    const source = readFileSync(CLIENT_SRC_PATH, 'utf8');
    _clientSourceFile = ts.createSourceFile(
      CLIENT_SRC_PATH,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
  }
  return _clientSourceFile;
}

function findMethodDeclaration(
  sourceFile: ts.SourceFile,
  methodName: string,
): ts.MethodDeclaration {
  // Match only FULL method declarations (with a body) — skips overload
  // signatures that share the same name. Also surfaces a clear error if
  // multiple full definitions exist, so a future same-named method in a
  // second class can't silently become the wrong target.
  const matches: ts.MethodDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isMethodDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === methodName &&
      node.body !== undefined
    ) {
      matches.push(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (matches.length === 0) {
    throw new Error(`Could not find method declaration '${methodName}' (with body) in client.ts`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous: found ${matches.length} method declarations named '${methodName}' in client.ts — ` +
        `extend findMethodDeclaration to accept a parent-class constraint.`,
    );
  }
  return matches[0];
}

function extractFormDataFieldNames(
  method: ts.MethodDeclaration,
  formDataVarName: string,
): Set<string> {
  if (!method.body) {
    throw new Error(`Method '${method.name?.getText() ?? '<unknown>'}' has no body`);
  }

  // Matches `<formDataVarName>.append(...)` by identifier text only — no
  // symbol resolution. Assumption: `formDataVarName` is not rebound inside
  // nested scopes within the method. True for current client.ts; if that
  // ever changes, the bidirectional spec/SDK set comparison below will
  // surface the discrepancy as a drift failure.
  const names = new Set<string>();
  const callVisit = (node: ts.Node): void => {
    // Match: <formDataVarName>.append('NAME', ...)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === formDataVarName &&
      node.expression.name.text === 'append' &&
      node.arguments.length >= 1
    ) {
      const firstArg = node.arguments[0];
      if (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg)) {
        names.add(firstArg.text);
      }
    }
    ts.forEachChild(node, callVisit);
  };
  ts.forEachChild(method.body, callVisit);
  return names;
}

function containsCallTo(method: ts.MethodDeclaration, calleeName: string): boolean {
  if (!method.body) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === calleeName
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(method.body, visit);
  return found;
}

function assertFormDataMatchesSpec(
  sdkNames: Set<string>,
  specSchema: OpenApiSchema,
  endpointLabel: string,
) {
  const specProperties = new Set(Object.keys(specSchema.properties ?? {}));
  expect(
    specProperties.size,
    `spec requestBody for ${endpointLabel} has no properties — did the schema rename?`,
  ).toBeGreaterThan(0);

  expect(
    sdkNames.size,
    `no FormData.append() calls found for ${endpointLabel} in client.ts — has the variable been renamed?`,
  ).toBeGreaterThan(0);

  const sdkNotInSpec = [...sdkNames].filter(n => !specProperties.has(n));
  expect(
    sdkNotInSpec,
    `SDK sends FormData fields absent from spec at ${endpointLabel}: ${sdkNotInSpec.join(', ')}`,
  ).toEqual([]);

  const specRequired = specSchema.required ?? [];
  const requiredMissing = specRequired.filter(n => !sdkNames.has(n));
  expect(
    requiredMissing,
    `SDK is missing spec-required FormData fields at ${endpointLabel}: ${requiredMissing.join(', ')}`,
  ).toEqual([]);
}

// ---------------------------------------------------------------------------
// (a) Multipart-family FormData bodies — field-name drift
// ---------------------------------------------------------------------------

describe('contract drift — multipart-family FormData request bodies', () => {
  it('single-upload form.append() field names match POST /api/uploads spec', () => {
    const doc = loadSpec();
    const schema = getRequestBodySchema(doc, '/api/uploads', 'post', 'multipart/form-data');

    const sourceFile = parseClientSource();
    const method = findMethodDeclaration(sourceFile, 'singleUpload');
    const sdkNames = extractFormDataFieldNames(method, 'form');

    assertFormDataMatchesSpec(sdkNames, schema, 'POST /api/uploads');
  });

  it('multipart-initiate initiateForm.append() field names match POST /api/uploads/multipart/initiate spec', () => {
    const doc = loadSpec();
    const schema = getRequestBodySchema(
      doc,
      '/api/uploads/multipart/initiate',
      'post',
      'multipart/form-data',
    );

    const sourceFile = parseClientSource();
    const method = findMethodDeclaration(sourceFile, 'multipartUpload');
    const sdkNames = extractFormDataFieldNames(method, 'initiateForm');

    assertFormDataMatchesSpec(sdkNames, schema, 'POST /api/uploads/multipart/initiate');
  });
});

// ---------------------------------------------------------------------------
// (b) Workflow CREATE — JSON body (SDK hand-rolled via WorkflowCreatePayload)
//
// Compile-time side (keyof WorkflowCreatePayload ⇔ WORKFLOW_CREATE_PAYLOAD_KEYS)
// is enforced in src/types.ts — tsconfig.json excludes tests, so a type-level
// check here would be a silent no-op. Runtime side (spec ⇔ allow-list) is
// checked here.
// ---------------------------------------------------------------------------

describe('contract drift — workflow create JSON body', () => {
  it('spec WorkflowCreateRequest properties are covered by WORKFLOW_CREATE_PAYLOAD_KEYS', () => {
    const doc = loadSpec();
    const schema = getRequestBodySchema(doc, '/api/workflows', 'post', 'application/json');

    const specProperties = Object.keys(schema.properties ?? {});
    expect(
      specProperties.length,
      'spec WorkflowCreateRequest has no properties — did the schema rename?',
    ).toBeGreaterThan(0);

    const allowList = new Set<string>(WORKFLOW_CREATE_PAYLOAD_KEYS);
    const specNotInAllowList = specProperties.filter(p => !allowList.has(p));
    expect(
      specNotInAllowList,
      `spec POST /api/workflows has properties not in WORKFLOW_CREATE_PAYLOAD_KEYS: ${specNotInAllowList.join(', ')}. Update WORKFLOW_CREATE_PAYLOAD_KEYS (and WorkflowCreatePayload) in packages/typescript/src/types.ts to match.`,
    ).toEqual([]);

    const allowListNotInSpec = [...allowList].filter(k => !specProperties.includes(k));
    expect(
      allowListNotInSpec,
      `WORKFLOW_CREATE_PAYLOAD_KEYS has keys not in spec POST /api/workflows: ${allowListNotInSpec.join(', ')}. The spec may have renamed/removed these — reconcile WorkflowCreatePayload in types.ts.`,
    ).toEqual([]);
  });

  it('spec-required fields are covered by WORKFLOW_CREATE_PAYLOAD_KEYS', () => {
    const doc = loadSpec();
    const schema = getRequestBodySchema(doc, '/api/workflows', 'post', 'application/json');

    const specRequired = schema.required ?? [];
    const allowList = new Set<string>(WORKFLOW_CREATE_PAYLOAD_KEYS);
    const requiredMissing = specRequired.filter(r => !allowList.has(r));
    expect(
      requiredMissing,
      `spec POST /api/workflows requires fields not in WORKFLOW_CREATE_PAYLOAD_KEYS: ${requiredMissing.join(', ')}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (c) Multipart COMPLETE — refactor-reversion guard
// ---------------------------------------------------------------------------

describe('contract drift — multipart complete body uses generated ToJSON helper', () => {
  it('multipartUpload actually invokes MultipartCompleteRequestToJSON()', () => {
    // If someone reverts client.ts:multipartUpload back to a hand-rolled
    // `body: { upload_id: ..., parts: ... }` literal, this guard fails.
    // Field-name drift within the typed body is caught by tsc (compile step).
    //
    // AST-based check (not raw-text regex) so a comment or string that
    // happens to contain "MultipartCompleteRequestToJSON(" doesn't satisfy it.
    const sourceFile = parseClientSource();
    const method = findMethodDeclaration(sourceFile, 'multipartUpload');
    expect(
      containsCallTo(method, 'MultipartCompleteRequestToJSON'),
      'multipartUpload no longer calls MultipartCompleteRequestToJSON() — was the multipart-complete body unrefactored? Field-name drift on POST /api/uploads/multipart/complete is no longer caught by tsc.',
    ).toBe(true);
  });
});
