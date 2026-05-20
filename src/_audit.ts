// Per ticket J65ZERTi (T20) — public-API completeness audit gate.
//
// This file sits inside `src/` so it is type-checked by `tsc --noEmit`
// (the test directory is excluded from `tsconfig.json` so a test-side
// audit is dead — earlier follow-up review caught this). The list of
// type-only imports here IS the gate: if a regen drops or renames any
// symbol, `tsc` fails on the import line.
//
// Each `accept<T>()` call resolves the type parameter; the function
// itself is a no-op. The body is never invoked at runtime — only the
// import resolution matters.

import type {
  // Workflow warnings (Wave I PR #64) — surfaced on
  // WorkflowCreateResponse.warnings; consumers must be able to type
  // their warning-handling code without deep imports.
  WorkflowWarning,
  // Typed error payload types — paired with the GislApiError
  // subclasses in errors.ts which declare `payload: <Type>`. Without
  // these on the public surface, consumers cannot narrow on
  // `instanceof Gisl<X>Error` and read `error.payload` typed.
  BalanceExhaustedResponse,
  BalanceExhaustedResponseAllOfLinks,
  TierRestrictionResponse,
  FeatureTierRestrictedResponse,
  FeatureNotAvailableResponse,
  FeatureViolation,
  WorkflowExpiredResponse,
  AuthErrorResponse,
  // Workflow lifecycle / delivery / processing plan response shapes
  // (T4 + T7 introduced these for v2).
  WorkflowCancelResponse,
  WorkflowResumeResponse,
  WorkflowPausedDetail,
  WorkflowPausedDetailLinks,
  WorkflowEdge,
  DeliveryPlan,
  DeliveryPlanOutput,
  ProcessingPlan,
  ProcessingPlanJob,
  // Upload constraints (T5 — UploadResponse.constraintsApplied).
  UploadConstraintsApplied,
  // Webhook nested context.
  WebhookOperationContext,
  // Reachable from public client method options / returns — added in
  // the T20 follow-up after review caught the gaps.
  MultipartInitiateRequestMetadataHint,
  MetadataResponseDimensions,
  MetadataResponseExif,
  MetadataResponseExifGps,
  OperationResultMetrics,
  UploadSource,
  JobOutputSource,
  ConnectionSource,
  ExternalImportToken,
  // Schema-shape types reachable from OperationsSchemaResponse.operations.
  // Form-renderer helpers consume these one hop deep from getSchema().
  OperationSchemaDefinition,
  MimeGroupSchema,
  OptionSchema,
  PerValueAvailabilityEntry,
  OperationInputModel,
} from '@giveitsmaller/contracts/openapi';

// AsyncAPI multi-output completion envelopes (ADR-0009 §D2, ticket
// ghYWnXF7). Re-exported from `index.ts` so consumers of SSE/webhook
// payloads can type-narrow `outputs[]` on multi-output workflows.
import type {
  MultiOutputCompletion,
  PageIndexed,
  PositionIndexed,
  Unindexed,
} from '@giveitsmaller/contracts/asyncapi';

// SDK-side ergonomic alias for `MultiOutputCompletion.outputs[]` entries.
// The alias is defined in `index.ts`; the audit gate pins its presence
// on the public surface.
import type { OperationResultOutputEntry } from './index.js';

// SDK-3 (Wb6ebOMM) — hand-coded resume-support types in types.ts. The
// `_Sdk3HandCoded` prefix marks them as transient (replaced on HxUmVr3Y
// regen). The audit gate pins their presence on the public surface so a
// rename / drop on regen surfaces as a `tsc --noEmit` failure here.
import type {
  MultipartCheckpointState,
  _Sdk3HandCodedUploadedPart,
  _Sdk3HandCodedMultipartStatusResult,
  _Sdk3HandCodedPresignedPart,
  _Sdk3HandCodedPresignPartsResult,
  _Sdk3HandCodedKeepaliveResult,
} from './types.js';

function accept<T>(_value?: T): void {
  // intentionally empty — type-presence is the assertion
}

// One call per imported type. tsc resolves the type parameter against
// the import; if the import is broken, the call site fails to compile.
export function _runAudit(): void {
  accept<WorkflowWarning>();
  accept<BalanceExhaustedResponse>();
  accept<BalanceExhaustedResponseAllOfLinks>();
  accept<TierRestrictionResponse>();
  accept<FeatureTierRestrictedResponse>();
  accept<FeatureNotAvailableResponse>();
  accept<FeatureViolation>();
  accept<WorkflowExpiredResponse>();
  accept<AuthErrorResponse>();
  accept<WorkflowCancelResponse>();
  accept<WorkflowResumeResponse>();
  accept<WorkflowPausedDetail>();
  accept<WorkflowPausedDetailLinks>();
  accept<WorkflowEdge>();
  accept<DeliveryPlan>();
  accept<DeliveryPlanOutput>();
  accept<ProcessingPlan>();
  accept<ProcessingPlanJob>();
  accept<UploadConstraintsApplied>();
  accept<WebhookOperationContext>();
  accept<MultipartInitiateRequestMetadataHint>();
  accept<MetadataResponseDimensions>();
  accept<MetadataResponseExif>();
  accept<MetadataResponseExifGps>();
  accept<OperationResultMetrics>();
  accept<UploadSource>();
  accept<JobOutputSource>();
  accept<ConnectionSource>();
  accept<ExternalImportToken>();
  accept<OperationSchemaDefinition>();
  accept<MimeGroupSchema>();
  accept<OptionSchema>();
  accept<PerValueAvailabilityEntry>();
  accept<OperationInputModel>();
  accept<MultiOutputCompletion>();
  accept<PageIndexed>();
  accept<PositionIndexed>();
  accept<Unindexed>();
  accept<OperationResultOutputEntry>();
  // SDK-3 (Wb6ebOMM) public-API surface for the 3 resume-support endpoints.
  accept<MultipartCheckpointState>();
  accept<_Sdk3HandCodedUploadedPart>();
  accept<_Sdk3HandCodedMultipartStatusResult>();
  accept<_Sdk3HandCodedPresignedPart>();
  accept<_Sdk3HandCodedPresignPartsResult>();
  accept<_Sdk3HandCodedKeepaliveResult>();
}
