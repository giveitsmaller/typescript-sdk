// iOcpCt6L — the WIRE shapes of the SSE `event.data` payloads.
//
// `parseSseStream` / `streamEvents` hand `event.data` over exactly as
// `JSON.parse` produced it: snake_case keys, no `*FromJSON` conversion. That is
// a deliberate cross-SDK decision (2026-05-16; see `GislSseEvent.php` and the
// shared `tests/parity/fixtures/sse_*.yaml`, which assert snake_case data for
// both SDKs). These interfaces describe THAT object. The camelCase
// `Sse*Data` models from `@giveitsmaller/contracts/openapi` describe the output
// of the generated `*FromJSON` helpers, which the stream never runs.
//
// They are hand-written, so they can drift from the contract. The drift gate is
// `tests/unit/sse-wire-drift.test.ts`: it compares every interface's key set
// (and which keys are required) with the vendored OpenAPI schema it mirrors,
// and fails when the contract adds, removes or renames a property. Edit the
// interface and that test's key list together.
export {};
