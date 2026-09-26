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
  LongFormConcurrencyLimitResponse,
  LongFormConcurrencyLimitResponseAllOfLinks,
  TierRestrictionResponse,
  FeatureTierRestrictedResponse,
  FeatureNotAvailableResponse,
  FeatureViolation,
  WorkflowExpiredResponse,
  ProbePendingResponse,
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
  PerRoleCardinalityEntry,
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

// FF1 (3BIxEnfR) — file-first result surface. Imported via `./index.js`
// so dropping the re-export breaks `tsc --noEmit` here.
import type {
  RunResult,
  OutputFile,
  ItemResult,
  ItemFailure,
  Manifest,
  Downloader,
  // FF2b (tywwynmN) — Node streaming downloader bound by Recipe.run().
  HttpDownloader,
  // FF3a (u0hBt6fl) — homogeneous fan-out builder (`client.files([...])`).
  FilesRecipe,
  // FF7 (MFaCjL8d) — keyed multi-recipe batch builder (`client.batch([...])`).
  BatchRecipe,
  // FF4a (Z7zTr789) — multi-input watermark recipe (`file(b).watermark(overlay)`).
  WatermarkedRecipe,
  WatermarkWireOp,
} from './index.js';
import type { GislNoSuchKeyError, GislSinkError, GislNetworkError, GislItemFailedError } from './index.js';
// FF5a (Ao8RPVxD) — file-first StatusSnapshot value object + the
// result-not-ready error (the FF5a-enriched `Handle` is already pinned
// below). Imported via `./index.js` so dropping the re-export breaks
// `tsc --noEmit` here.
import type { StatusSnapshot, GislResultNotReadyError } from './index.js';
// TYNjcjpo — SSE parse-failure diagnostic surfaced via the `onParseError`
// callback on `streamEvents` / `parseSseStream`. Imported via `./index.js`
// so dropping the re-export breaks `tsc --noEmit` here.
import type { GislSseParseFailure } from './index.js';
// qUhxfDA5 — capabilities() projection VO + the three contract capability
// types it exposes. All imported via `./index.js` so dropping either the VO
// export or the contract-type re-exports breaks `tsc --noEmit` here.
import type {
  CapabilitiesSnapshot,
  OperationCapability,
  OutputProperties,
  ImageEncodeCapabilities,
} from './index.js';
import type {
  AccountLimits,
  CreditsBalanceResponse,
  CreditsUsageResponse,
  CreditsUsageOptions,
} from './index.js';
// W8v4jWzx — the error-taxonomy category union surfaced by
// `GislApiError.category`. Imported via `./index.js` so dropping the type-only
// re-export breaks `tsc --noEmit` here.
import type { ErrorCategory } from './index.js';

// Ergonomic-layer entry points (T1 / wVU4xHx3) — `gisl.create()` factory
// + credential-chain types + the new local-error tree (GislConfigError +
// GislMissingCredentialsError + GislFeatureRequiresAuthError). Sibling to
// GislApiError; thrown before any I/O.
//
// Public-surface types imported via `./index.js` (NOT `./gisl.js`) so
// removing the index.ts re-export breaks `tsc --noEmit` here — the
// purpose of the audit gate (codex r2 low a8b2e50caf83). The
// `ANONYMOUS_ALLOWLIST` invariant is imported from `./gisl.js` directly
// since the constant is intentionally NOT re-exported from index.ts
// (internal).
import type {
  GislCreateOptions,
  GislAnonymousOptions,
  Environment,
  ErgonomicClient,
  Artifact,
  ArtifactRef,
  Handle,
  Result,
  RunOptions,
  SubmitOptions,
  ProgressEvent,
  Asset,
  ClipEntry,
  ClipOptions,
  MergeOptions,
  MergeMediaKind,
  SequenceEntry,
  // T4a / VhIj4S7T — preset-defaults builder + leaf DTOs + ergonomic enums.
  PresetDefaults,
  PresetMedia,
  PresetOp,
  AnyPresetOptions,
  ImageCompressPresetOptions,
  ImageCompressPresetOptionsInput,
  AudioCompressPresetOptions,
  AudioCompressPresetOptionsInput,
  VideoCompressPresetOptions,
  VideoCompressPresetOptionsInput,
  DocumentOfficeCompressPresetOptions,
  DocumentOfficeCompressPresetOptionsInput,
  DocumentOdfCompressPresetOptions,
  DocumentOdfCompressPresetOptionsInput,
  DocumentEpubCompressPresetOptions,
  DocumentEpubCompressPresetOptionsInput,
  OptimizeFor,
  ImageMetadataPolicy,
  ImageFormat,
  VideoCodec,
  VideoPreset,
  VideoFit,
  AudioBitrate,
  AudioCodec,
  AudioSampleRate,
  // T4b / 27rE1fZn — resolver public surface + augmented GislConfigError metadata.
  GislConfigErrorMetadata,
  ResolvedOptionsSources,
  ResolveCompressOptionsInput,
  ResolveCompressOptionsOutput,
} from './index.js';
import { ANONYMOUS_ALLOWLIST } from './gisl.js';
import type { GislClient } from './client.js';

// BQXpFV2R — the 13 ergonomic symbols the gate never pinned, plus the exact-equality
// helper the signature pins need.
//
// ⚠️ SEVEN OF THESE ARE VALUE-ONLY and have no type meaning: `gisl`, `create`,
// `fileInput`, `asset`, `handle`, `clip`, `verifyWebhook`. `accept<gisl>()` does not
// compile; they are pinned as `accept<typeof X>()` below. The six classes take both
// forms — `accept<X>()` pins the instance type, `accept<typeof X>()` the constructor.
import type { Equal } from './ergonomic/option_types.js';
import {
  gisl,
  create,
  Recipe,
  fileInput,
  OperationBuilder,
  MergeBuilder,
  MergedRecipe,
  ArchivedRecipe,
  MapEachBuilder,
  asset,
  handle,
  clip,
  verifyWebhook,
} from './index.js';

// The anonymous allowlist was PARKED (an empty tuple, asserted empty here)
// until the owner picked the guest rule; decision 610(4) flipped it together
// with the public `gisl.anonymous()` door (OuegCUtq). What is pinned now:
// the list is non-empty, every entry names a real `GislClient` method (a
// rename there breaks this, not a runtime gate that silently lets nothing
// through), and the door it exists for is on the `gisl` namespace. Which
// methods belong on it is the conformance test's job, against the contract.
type _AllowlistEntry = (typeof ANONYMOUS_ALLOWLIST)[number];
type _AllowlistNonEmpty = typeof ANONYMOUS_ALLOWLIST extends readonly [] ? false : true;
type _AllowlistNamesClientMethods = _AllowlistEntry extends keyof GislClient ? true : false;
type _AnonymousDoorExported = 'anonymous' extends keyof typeof gisl ? true : false;
type _AssertTrueAnon<T extends true> = T;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AnonymousAllowlistInvariant = [
  _AssertTrueAnon<_AllowlistNonEmpty>,
  _AssertTrueAnon<_AllowlistNamesClientMethods>,
  _AssertTrueAnon<_AnonymousDoorExported>,
];

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
  accept<LongFormConcurrencyLimitResponse>();
  accept<LongFormConcurrencyLimitResponseAllOfLinks>();
  accept<TierRestrictionResponse>();
  accept<FeatureTierRestrictedResponse>();
  accept<FeatureNotAvailableResponse>();
  accept<FeatureViolation>();
  accept<WorkflowExpiredResponse>();
  accept<ProbePendingResponse>();
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
  accept<PerRoleCardinalityEntry>();
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
  // T1 / wVU4xHx3 — ergonomic-layer entry points.
  accept<GislCreateOptions>();
  accept<GislAnonymousOptions>();
  accept<Environment>();
  // T2 / xVDTIm8C — operation-builder surface.
  accept<ErgonomicClient>();
  // 8yqUXLCS — pin the credits/limits accessor SIGNATURES on ErgonomicClient.
  // accept<ErgonomicClient>() proves the type compiles; these prove the three
  // methods EXIST and their signatures/return types match (indexed access errors
  // if a method is missing; the typed LHS errors if the signature drifts). The
  // RHS is a type-only cast (`null as unknown as …`) — no runtime property read.
  //
  // 🔴 THE ASSIGNMENT FORM BELOW WAS WEAKER THAN IT LOOKED, AND IS NOW FIXED.
  // A single assignment tests ONE-WAY assignability, so a drift to `any` — or to any
  // broader callable — stays assignable and PASSES. Assigning both ways does not fix
  // it either: `any` is assignable in both directions. Real equality needs a
  // conditional-type helper, and this repo already had one in
  // `ergonomic/option_types.ts`, used there to pin option key-sets to the contract.
  // ⇒ These three have been decorative since 8yqUXLCS shipped them. Tightened here
  // rather than left one-way beside sixteen correct ones.
  const _creditsSig: Equal<ErgonomicClient['credits'], () => Promise<CreditsBalanceResponse>> = true;
  const _creditsUsageSig: Equal<
    ErgonomicClient['creditsUsage'],
    (options?: CreditsUsageOptions) => Promise<CreditsUsageResponse>
  > = true;
  const _limitsSig: Equal<ErgonomicClient['limits'], () => Promise<AccountLimits>> = true;
  void _creditsSig;
  void _creditsUsageSig;
  void _limitsSig;

  // ── BQXpFV2R — the thirteen unpinned ergonomic symbols ────────────────────────
  //
  // ⚠️ EXISTENCE IS NOW THE SNAPSHOT'S JOB, not this list's.
  // `tests/api-surface.test.ts` computes all 381 exports from source and compares
  // them to a committed file, so a symbol cannot go unpinned because nobody
  // remembered it — which is exactly how these thirteen were missed, alongside the
  // whole `Gisl*Error` tree and `GislClient` itself. What remains here is the part a
  // name-and-kind snapshot CANNOT express: SIGNATURES.
  //
  // ⚠️ COVERAGE BOUNDARY, stated so the gate is not mistaken for complete:
  // signatures are pinned for the nine builders' execution methods and the three
  // ErgonomicClient accessors above. A signature change to `GislClient`, `gisl`,
  // `create` or `parseSseStream` is caught by NOTHING here. That is a deliberate
  // scope line — widening it is ticket `YebCTMuY`.
  accept<typeof gisl>();
  accept<typeof create>();
  accept<typeof fileInput>();
  accept<typeof asset>();
  accept<typeof handle>();
  accept<typeof clip>();
  accept<typeof verifyWebhook>();
  accept<Recipe>();
  accept<typeof Recipe>();
  accept<OperationBuilder>();
  accept<typeof OperationBuilder>();
  accept<MergeBuilder>();
  accept<typeof MergeBuilder>();
  accept<MergedRecipe>();
  accept<typeof MergedRecipe>();
  accept<ArchivedRecipe>();
  accept<typeof ArchivedRecipe>();
  accept<MapEachBuilder>();
  accept<typeof MapEachBuilder>();

  // ── Execution-method signatures: sixteen pins across nine classes ─────────────
  //
  // `run()` AND `submit()` on the seven that have both; `run()` ONLY on BatchRecipe
  // and MapEachBuilder, which deliberately have no `submit()`. ⚠️ Pinning a
  // `submit()` they do not have would INVENT API, so the asymmetry is the point.
  // Each uses `Equal<>`, not assignment — see the note above.
  // ⚠️ EACH PIN NAMES THE EXPECTED SIGNATURE EXPLICITLY. `Equal<X['run'], X['run']>`
  // would be trivially true and assert NOTHING — a decoration of exactly the kind
  // this ticket exists to remove. The right-hand side is written out, so a drift in
  // parameters or return type fails here naming the symbol.
  //
  // The file-first builders share one `run` options bag and one `submit` shape;
  // OperationBuilder and MergeBuilder take the typed `RunOptions` / `SubmitOptions`
  // objects instead. ⚠️ THAT DIVERGENCE IS REAL AND DELIBERATE-BY-ACCIDENT — it is
  // ticket `36AZ98FV`. Pinning both shapes here records it rather than hiding it.
  type FileFirstRun<R> = (options?: {
    maxWait?: string | number;
    onProgress?: (event: ProgressEvent) => void;
    signal?: AbortSignal;
    useSSE?: boolean;
    pollIntervalMs?: number;
    probeBeforeCreate?: boolean;
    probeTimeoutMs?: number;
  }) => Promise<R>;
  type FileFirstSubmit = (
    webhook?: string,
    options?: { probeBeforeCreate?: boolean; probeTimeoutMs?: number },
  ) => Promise<Handle>;

  const _recipeRun: Equal<Recipe['run'], FileFirstRun<RunResult>> = true;
  const _recipeSubmit: Equal<Recipe['submit'], FileFirstSubmit> = true;
  const _filesRun: Equal<FilesRecipe['run'], FileFirstRun<RunResult>> = true;
  const _filesSubmit: Equal<FilesRecipe['submit'], FileFirstSubmit> = true;
  const _mergedRun: Equal<MergedRecipe['run'], FileFirstRun<RunResult>> = true;
  const _mergedSubmit: Equal<MergedRecipe['submit'], FileFirstSubmit> = true;
  const _archivedRun: Equal<ArchivedRecipe['run'], FileFirstRun<RunResult>> = true;
  const _archivedSubmit: Equal<ArchivedRecipe['submit'], FileFirstSubmit> = true;
  const _watermarkedRun: Equal<WatermarkedRecipe['run'], FileFirstRun<RunResult>> = true;
  const _watermarkedSubmit: Equal<WatermarkedRecipe['submit'], FileFirstSubmit> = true;
  const _batchRun: Equal<BatchRecipe['run'], FileFirstRun<RunResult>> = true;

  const _opRun: Equal<OperationBuilder['run'], (options?: RunOptions) => Promise<Result>> = true;
  const _opSubmit: Equal<OperationBuilder['submit'], (options?: SubmitOptions) => Promise<Handle>> =
    true;
  const _mergeRun: Equal<MergeBuilder['run'], (options?: RunOptions) => Promise<Result>> = true;
  const _mergeSubmit: Equal<MergeBuilder['submit'], (options?: SubmitOptions) => Promise<Handle>> =
    true;
  // ⚠️ `Promise<Result>`, NOT `Promise<Result[]>`. A fan-out returns ONE aggregate
  // result carrying `childWorkflowIds`, not an array. I wrote `Result[]` from
  // assumption and this pin failed on its first compile — the gate catching a wrong
  // belief before any mutation test, which is the whole point of writing it out.
  const _mapEachRun: Equal<MapEachBuilder['run'], (options?: RunOptions) => Promise<Result>> = true;

  void _recipeRun; void _recipeSubmit; void _filesRun; void _filesSubmit;
  void _mergedRun; void _mergedSubmit; void _archivedRun; void _archivedSubmit;
  void _watermarkedRun; void _watermarkedSubmit; void _batchRun;
  void _opRun; void _opSubmit; void _mergeRun; void _mergeSubmit; void _mapEachRun;
  accept<Artifact>();
  accept<Handle>();
  accept<Result>();
  accept<RunOptions>();
  accept<SubmitOptions>();
  accept<ProgressEvent>();
  // T3 / cuecCmb5 — merge-compose surface.
  accept<Asset>();
  accept<ClipEntry>();
  accept<ClipOptions>();
  accept<MergeOptions>();
  accept<MergeMediaKind>();
  accept<SequenceEntry>();
  // T6 / aDR1jnyZ — fan-out surface.
  accept<ArtifactRef>();
  // T4a / VhIj4S7T — preset-defaults surface.
  accept<PresetDefaults>();
  accept<PresetMedia>();
  accept<PresetOp>();
  accept<AnyPresetOptions>();
  accept<ImageCompressPresetOptions>();
  accept<ImageCompressPresetOptionsInput>();
  accept<AudioCompressPresetOptions>();
  accept<AudioCompressPresetOptionsInput>();
  accept<VideoCompressPresetOptions>();
  accept<VideoCompressPresetOptionsInput>();
  accept<DocumentOfficeCompressPresetOptions>();
  accept<DocumentOfficeCompressPresetOptionsInput>();
  accept<DocumentOdfCompressPresetOptions>();
  accept<DocumentOdfCompressPresetOptionsInput>();
  accept<DocumentEpubCompressPresetOptions>();
  accept<DocumentEpubCompressPresetOptionsInput>();
  accept<OptimizeFor>();
  accept<ImageMetadataPolicy>();
  accept<ImageFormat>();
  accept<VideoCodec>();
  accept<VideoPreset>();
  accept<VideoFit>();
  accept<AudioBitrate>();
  accept<AudioCodec>();
  accept<AudioSampleRate>();
  // T4b / 27rE1fZn — preset resolver public types.
  accept<GislConfigErrorMetadata>();
  accept<ResolvedOptionsSources>();
  accept<ResolveCompressOptionsInput>();
  accept<ResolveCompressOptionsOutput>();
  // FF1 / 3BIxEnfR — file-first result surface + sink errors.
  accept<RunResult>();
  accept<OutputFile>();
  accept<ItemResult>();
  accept<ItemFailure>();
  accept<Manifest>();
  accept<Downloader>();
  accept<HttpDownloader>();
  // FF3a / u0hBt6fl — homogeneous fan-out builder surface.
  accept<FilesRecipe>();
  // FF7 / MFaCjL8d — keyed multi-recipe batch builder surface.
  accept<BatchRecipe>();
  // FF4a / Z7zTr789 — multi-input watermark recipe surface.
  accept<WatermarkedRecipe>();
  accept<WatermarkWireOp>();
  accept<GislNoSuchKeyError>();
  accept<GislSinkError>();
  accept<GislItemFailedError>();
  accept<GislNetworkError>();
  // FF5a / Ao8RPVxD — file-first Handle reattach surface.
  accept<StatusSnapshot>();
  accept<GislResultNotReadyError>();
  // TYNjcjpo — SSE parse-failure diagnostic surface.
  accept<GislSseParseFailure>();
  // qUhxfDA5 — capabilities() projection surface + the three contract
  // capability types it exposes.
  accept<CapabilitiesSnapshot>();
  accept<OperationCapability>();
  accept<OutputProperties>();
  accept<ImageEncodeCapabilities>();
  // W8v4jWzx — error-taxonomy category union surfaced by GislApiError.category.
  accept<ErrorCategory>();
}
