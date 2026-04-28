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
}
