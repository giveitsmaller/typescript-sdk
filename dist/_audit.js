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
function accept(_value) {
    // intentionally empty — type-presence is the assertion
}
// One call per imported type. tsc resolves the type parameter against
// the import; if the import is broken, the call site fails to compile.
export function _runAudit() {
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    // SDK-3 (Wb6ebOMM) public-API surface for the 3 resume-support endpoints.
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    // T1 / wVU4xHx3 — ergonomic-layer entry points.
    accept();
    accept();
    // T2 / xVDTIm8C — operation-builder surface.
    accept();
    // 8yqUXLCS — pin the credits/limits accessor SIGNATURES on ErgonomicClient.
    // accept<ErgonomicClient>() proves the type compiles; these prove the three
    // methods EXIST and their signatures/return types match (indexed access errors
    // if a method is missing; the typed LHS errors if the signature drifts). The
    // RHS is a type-only cast (`null as unknown as …`) — no runtime property read.
    const _creditsSig = null;
    const _creditsUsageSig = null;
    const _limitsSig = null;
    void _creditsSig;
    void _creditsUsageSig;
    void _limitsSig;
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    // T3 / cuecCmb5 — merge-compose surface.
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    // T6 / aDR1jnyZ — fan-out surface.
    accept();
    // T4a / VhIj4S7T — preset-defaults surface.
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    // T4b / 27rE1fZn — preset resolver public types.
    accept();
    accept();
    accept();
    accept();
    // FF1 / 3BIxEnfR — file-first result surface + sink errors.
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    // FF3a / u0hBt6fl — homogeneous fan-out builder surface.
    accept();
    // FF4a / Z7zTr789 — multi-input watermark recipe surface.
    accept();
    accept();
    accept();
    accept();
    accept();
    accept();
    // FF5a / Ao8RPVxD — file-first Handle reattach surface.
    accept();
    accept();
    // TYNjcjpo — SSE parse-failure diagnostic surface.
    accept();
}
