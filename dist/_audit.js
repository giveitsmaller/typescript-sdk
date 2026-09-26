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
    accept();
    // T2 / xVDTIm8C — operation-builder surface.
    accept();
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
    const _creditsSig = true;
    const _creditsUsageSig = true;
    const _limitsSig = true;
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
    const _recipeRun = true;
    const _recipeSubmit = true;
    const _filesRun = true;
    const _filesSubmit = true;
    const _mergedRun = true;
    const _mergedSubmit = true;
    const _archivedRun = true;
    const _archivedSubmit = true;
    const _watermarkedRun = true;
    const _watermarkedSubmit = true;
    const _batchRun = true;
    const _opRun = true;
    const _opSubmit = true;
    const _mergeRun = true;
    const _mergeSubmit = true;
    // ⚠️ `Promise<Result>`, NOT `Promise<Result[]>`. A fan-out returns ONE aggregate
    // result carrying `childWorkflowIds`, not an array. I wrote `Result[]` from
    // assumption and this pin failed on its first compile — the gate catching a wrong
    // belief before any mutation test, which is the whole point of writing it out.
    const _mapEachRun = true;
    void _recipeRun;
    void _recipeSubmit;
    void _filesRun;
    void _filesSubmit;
    void _mergedRun;
    void _mergedSubmit;
    void _archivedRun;
    void _archivedSubmit;
    void _watermarkedRun;
    void _watermarkedSubmit;
    void _batchRun;
    void _opRun;
    void _opSubmit;
    void _mergeRun;
    void _mergeSubmit;
    void _mapEachRun;
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
    // FF7 / MFaCjL8d — keyed multi-recipe batch builder surface.
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
    // qUhxfDA5 — capabilities() projection surface + the three contract
    // capability types it exposes.
    accept();
    accept();
    accept();
    accept();
    // W8v4jWzx — error-taxonomy category union surfaced by GislApiError.category.
    accept();
}
