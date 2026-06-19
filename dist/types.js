// ---------------------------------------------------------------------------
// Source factories — return wire-format objects with the `type` discriminator
// ---------------------------------------------------------------------------
export function uploadSource(fileId) {
    return { type: 'upload', file_id: fileId };
}
export function jobOutputSource(from, operation) {
    return operation === undefined
        ? { type: 'job_output', from }
        : { type: 'job_output', from, operation };
}
export function externalImportSource(externalSourceId) {
    return { type: 'external_import', external_source_id: externalSourceId };
}
export function connectionSource(connectionId, path) {
    return { type: 'connection', connection_id: connectionId, path };
}
/**
 * Single source of truth for JobDefinitionPayload's top-level wire keys.
 * Read by `contract-drift-fields.test.ts` to cross-check against the spec
 * at `JobDefinition`. Not re-exported from `index.ts`; this is reachable
 * only via deep imports and should not be treated as public API.
 *
 * The V1-only `skip_compression` field is deliberately absent (eQnUMW68);
 * the runtime drift test will fail if the spec re-introduces it OR adds
 * any other V1-leak field to the V2 JobDefinition schema.
 * @internal
 */
export const JOB_DEFINITION_PAYLOAD_KEYS = Object.freeze([
    'id',
    'source',
    'inputs',
    'operations',
    'deliver',
]);
/**
 * Single source of truth for WorkflowCreatePayload's top-level wire keys.
 * Read by `contract-drift-fields.test.ts` to cross-check against the spec at
 * POST /api/workflows. Not re-exported from `index.ts`; this is reachable
 * only via deep imports and should not be treated as public API.
 * @internal
 */
export const WORKFLOW_CREATE_PAYLOAD_KEYS = Object.freeze([
    'jobs',
    'source',
    'operations',
    'workflow_edges',
    'callback_url',
    'callback_events',
    'export',
    'delivery',
    'processing',
]);
