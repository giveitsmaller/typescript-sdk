import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';

import { loadFixtures, isToken, type Fixture } from './fixtures.js';
import { createFetchStub, type FetchStub } from './fetch-stub.js';
import {
  compareRequests,
  compareValue,
  compareResolvedOptions,
  compareOmittedFromWire,
  compareLocalValidationError,
  type CapturedResolvedOptions,
  type CapturedLocalValidationError,
} from './comparators.js';
import {
  invokeFixture,
  lowerFixture,
  runRecipeFixture,
  submitRecipeFixture,
  lowerFilesFixture,
  runFilesFixture,
  submitFilesFixture,
} from './invoke.js';
import { GislConfigError } from '../../src/errors.js';

// ---------------------------------------------------------------------------
// Regeneration mode. Run via `npm run parity:update`. Refuses to run in CI —
// fixtures are spec artefacts and must be updated deliberately on a human's
// machine, never from a PR checks run. Only expected_return is rewritten;
// request assertions still run so an intentional expected_return change
// cannot mask a request drift.
// ---------------------------------------------------------------------------

const UPDATE_MODE = process.env.UPDATE_PARITY_FIXTURES === '1';
if (UPDATE_MODE && process.env.CI === 'true') {
  throw new Error(
    'UPDATE_PARITY_FIXTURES=1 is a local-only regeneration path. Unset CI or unset UPDATE_PARITY_FIXTURES.',
  );
}

// Cross-SDK known divergences (mirrors packages/php/tests/parity/ParityTest
// KNOWN_DIVERGENCES). These shared fixtures pin a sub-contract-minimum
// `recommended_chunk_size` (~2 MB) to keep the binary payload compact. The
// PHP SDK already skips them (its strict generated model rejects
// recommendedChunkSize below the contract minimum). The TS SDK now enforces
// the SAME contract-range guard (codex review — closing the previously lax
// TS path), so it skips the same fixtures for the same reason. The
// happy-path multipart wire shape is covered by tests/unit/client.test.ts
// and upload-streaming.test.ts with contract-valid chunk sizes.
const KNOWN_DIVERGENCES: Record<string, string> = {
  upload_multipart:
    'SDK rejects recommendedChunkSize below the contract minimum; fixture pins ~2 MB for a compact payload. Covered by client.test.ts/upload-streaming.test.ts with valid chunk sizes.',
  upload_metadata_hint:
    'Same sub-minimum recommendedChunkSize as upload_multipart.',
  upload_boundary_multipart:
    'Same sub-minimum recommendedChunkSize as upload_multipart.',
};

const fixtures = loadFixtures();

describe('cross-SDK parity', () => {
  let stub: FetchStub | undefined;

  beforeEach(() => {
    stub = undefined;
  });

  afterEach(() => {
    stub?.restore();
  });

  describe.each(fixtures)('$name', (fixture: Fixture) => {
    it(fixture.description ?? fixture.name, async (ctx) => {
      if (fixture.name in KNOWN_DIVERGENCES) {
        ctx.skip();
      }
      if (fixture.mode === 'webhook') {
        // Webhook mode makes no HTTP calls; invoke directly.
        const { returnValue } = await invokeFixture(fixture);
        expect(returnValue, `fixture ${fixture.name}: verifyWebhook returned false`).toBe(true);
        return;
      }

      if (fixture.mode === 'local_validation_error') {
        // F4-A — the SDK is expected to throw BEFORE any HTTP call. Stub
        // installed so a regression that DOES leak a request fails loudly
        // (captured.length > 0 surfaces via the post-invoke assertion).
        stub = createFetchStub();
        stub.install([], fixture.__file);
        const { thrown } = await invokeFixture(fixture);
        if (stub.captured.length !== 0) {
          throw new Error(
            `[${fixture.name}] mode=local_validation_error must not issue any HTTP calls; captured ${stub.captured.length}`,
          );
        }
        if (thrown === undefined) {
          throw new Error(
            `[${fixture.name}] mode=local_validation_error expected the SDK to throw, but no error was caught`,
          );
        }
        if (fixture.localValidationError !== undefined) {
          const diff = compareLocalValidationError(
            fixture.localValidationError,
            extractLocalValidationError(thrown),
          );
          if (!diff.ok) {
            throw new Error(
              `[${fixture.name}] localValidationError parity failure:\n  - ${diff.issues.join('\n  - ')}`,
            );
          }
        }
        return;
      }

      // FF2b (tywwynmN) — mode=run drives the recipe through .run() against the
      // fetch stub and deep-compares the hydrated RunResult DATA shape. The
      // Downloader is NOT exercised (canned download URLs). HARNESS NOTE: the
      // fetch stub serves the upload/create/terminal/downloads responses in
      // call order; the run-mode assertion depends on that wiring landing with
      // the rest of the harness build-out (F4-B / cEUWPgKW).
      if (fixture.mode === 'run') {
        stub = createFetchStub();
        stub.install(fixture.responses, fixture.__file);
        const actualRun = await runRecipeFixture(fixture);
        const diff = compareValue(
          fixture.expected_run_result,
          actualRun as unknown as never,
          'expected_run_result',
        );
        if (!diff.ok) {
          throw new Error(
            `[${fixture.name}] run parity failure:\n  - ${diff.issues.join('\n  - ')}`,
          );
        }
        return;
      }

      // FF3a (u0hBt6fl) — mode=files homogeneous fan-out. Two variants share
      // the one files block: the lowering variant (expected_payload, no
      // network) deep-compares the lowered multi-job payload; the run variant
      // (expected_run_result) installs the stub, drives .run(), and
      // deep-compares the partitioned RunResult. HARNESS NOTE: the run variant
      // depends on the fetch stub serving the canned responses in call order
      // (F4-B / cEUWPgKW), same as mode=run.
      if (fixture.mode === 'files') {
        // uUnCtVAr (FF3a-submit) — a `files.webhook` routes the fan-out
        // through FilesRecipe.submit(): install the stub, drive submit(), then
        // assert BOTH the captured create request (multi-job callback_url) AND
        // the returned Handle (expected_return). Mirrors the single-file submit
        // arm below.
        if (fixture.files?.webhook !== undefined) {
          stub = createFetchStub();
          stub.install(fixture.responses, fixture.__file);
          const handleJson = await submitFilesFixture(fixture);
          const requestDiff = compareRequests(fixture.requests, stub.captured, fixture.__file);
          if (!requestDiff.ok) {
            throw new Error(
              `[${fixture.name}] files submit request parity failure:\n  - ${requestDiff.issues.join('\n  - ')}`,
            );
          }
          if (fixture.expected_return !== undefined) {
            const returnDiff = compareValue(
              fixture.expected_return,
              handleJson as never,
              'expected_return',
            );
            if (!returnDiff.ok) {
              throw new Error(
                `[${fixture.name}] files submit return parity failure:\n  - ${returnDiff.issues.join('\n  - ')}`,
              );
            }
          }
          return;
        }
        if (fixture.expected_payload !== undefined) {
          const lowered = lowerFilesFixture(fixture);
          const diff = compareValue(
            fixture.expected_payload,
            lowered as unknown as never,
            'expected_payload',
          );
          if (!diff.ok) {
            throw new Error(
              `[${fixture.name}] files lowering parity failure:\n  - ${diff.issues.join('\n  - ')}`,
            );
          }
          return;
        }
        stub = createFetchStub();
        stub.install(fixture.responses, fixture.__file);
        const actualRun = await runFilesFixture(fixture);
        const diff = compareValue(
          fixture.expected_run_result,
          actualRun as unknown as never,
          'expected_run_result',
        );
        if (!diff.ok) {
          throw new Error(
            `[${fixture.name}] files run parity failure:\n  - ${diff.issues.join('\n  - ')}`,
          );
        }
        return;
      }

      if (fixture.mode === 'lowering') {
        // FF2a — build the file-first Recipe from the chain spec, lower it
        // (network-free), and deep-compare the wire payload to
        // expected_payload. Tokens are a no-op (lowering is deterministic).
        const lowered = lowerFixture(fixture);
        const diff = compareValue(
          fixture.expected_payload,
          lowered as unknown as never,
          'expected_payload',
        );
        if (!diff.ok) {
          throw new Error(
            `[${fixture.name}] lowering parity failure:\n  - ${diff.issues.join('\n  - ')}`,
          );
        }
        return;
      }

      // FF5b (u8M49LU2) — a submit block routes a file-first chain through the
      // standard request_response flow: install the stub, drive .submit(), then
      // assert BOTH the captured create request (callback_url) AND the returned
      // Handle (expected_return). Mode is request_response, so the generic path
      // below would route method:file to a non-existent GislClient method — this
      // arm intercepts it.
      if (fixture.submit !== undefined) {
        stub = createFetchStub();
        stub.install(fixture.responses, fixture.__file);
        const handleJson = await submitRecipeFixture(fixture);

        const requestDiff = compareRequests(fixture.requests, stub.captured, fixture.__file);
        if (!requestDiff.ok) {
          throw new Error(
            `[${fixture.name}] request parity failure:\n  - ${requestDiff.issues.join('\n  - ')}`,
          );
        }
        if (fixture.expected_return !== undefined) {
          const returnDiff = compareValue(
            fixture.expected_return,
            handleJson as never,
            'expected_return',
          );
          if (!returnDiff.ok) {
            throw new Error(
              `[${fixture.name}] return parity failure:\n  - ${returnDiff.issues.join('\n  - ')}`,
            );
          }
        }
        return;
      }

      stub = createFetchStub();
      stub.install(fixture.responses, fixture.__file);

      const { returnValue, sseEvents, thrown } = await invokeFixture(fixture);

      // An error-envelope fixture declares `expects_error: true` and asserts
      // only request-level parity. A non-error fixture that throws is a
      // genuine failure — surface the error message.
      if (thrown && !fixture.expects_error) {
        throw thrown;
      }
      if (fixture.expects_error && !thrown) {
        throw new Error(
          `[${fixture.name}] expects_error=true but the SDK did not throw`,
        );
      }

      const requestDiff = compareRequests(fixture.requests, stub.captured, fixture.__file);
      if (!requestDiff.ok) {
        throw new Error(
          `[${fixture.name}] request parity failure:\n  - ${requestDiff.issues.join('\n  - ')}`,
        );
      }

      // Error fixtures skip the return comparison — no return value exists.
      if (fixture.expects_error) return;

      const observed = fixture.mode === 'sse' ? sseEvents : returnValue;

      if (UPDATE_MODE) {
        writeExpectedReturn(fixture, observed);
        return;
      }

      if (fixture.expected_return !== undefined) {
        const returnDiff = compareValue(
          fixture.expected_return,
          observed as never,
          'expected_return',
        );
        if (!returnDiff.ok) {
          throw new Error(
            `[${fixture.name}] return parity failure:\n  - ${returnDiff.issues.join('\n  - ')}`,
          );
        }
      }

      // F4-A — v2 assertion blocks. resolvedOptions + omittedFromWire are
      // additive on top of the wire+return comparisons. Skipped for v1
      // fixtures (the loader rejects these keys on v1 so they can't be
      // present here).
      if (fixture.resolvedOptions !== undefined) {
        const actual = extractResolvedOptions(returnValue);
        const diff = compareResolvedOptions(fixture.resolvedOptions, actual);
        if (!diff.ok) {
          throw new Error(
            `[${fixture.name}] resolvedOptions parity failure:\n  - ${diff.issues.join('\n  - ')}`,
          );
        }
      }
      if (fixture.omittedFromWire !== undefined && fixture.omittedFromWire.length > 0) {
        const diff = compareOmittedFromWire(fixture.omittedFromWire, stub.captured);
        if (!diff.ok) {
          throw new Error(
            `[${fixture.name}] omittedFromWire parity failure:\n  - ${diff.issues.join('\n  - ')}`,
          );
        }
      }
    });
  });
});

/**
 * Project a caught error into the shape the localValidationError
 * comparator consumes. Recognises `GislConfigError` (T4b augmented
 * metadata) and falls back to `category: 'unknown'` for anything
 * else.
 */
function extractLocalValidationError(thrown: unknown): CapturedLocalValidationError {
  if (thrown === null || typeof thrown !== 'object') {
    return { category: 'unknown' };
  }
  // `instanceof GislConfigError` catches the full subclass tree
  // (`GislMissingCredentialsError`, `GislFeatureRequiresAuthError`,
  // `GislUndeclaredAssetError`, `GislUnusedAssetError`,
  // `GislPerInputOptionsNotSupportedError`,
  // `GislChainCardinalityMismatchError`) — code-review F4-A R1 caught
  // the name-string check was brittle; the equivalent PHP path at
  // `ParityTest::projectLocalValidationError` already uses `instanceof`.
  if (thrown instanceof GislConfigError) {
    const err = thrown as GislConfigError & {
      reason?: string;
      conflictingFields?: readonly string[];
    };
    return {
      category: 'validation',
      ...(err.reason !== undefined ? { code: err.reason } : {}),
      ...(err.conflictingFields !== undefined
        ? { conflictingFields: err.conflictingFields }
        : {}),
      ...(err.message !== undefined ? { message: err.message } : {}),
    };
  }
  const err = thrown as { message?: string };
  return {
    category: 'unknown',
    ...(err.message !== undefined ? { message: err.message } : {}),
  };
}

/**
 * Extract `result.resolvedOptions` from the ergonomic `Result`
 * returned by `.run()`. The runner's `returnValue` is the SDK
 * method's raw return value — for compress/convert/thumbnail it's a
 * `Result`; for other methods it's whatever the low-level method
 * returned.
 */
function extractResolvedOptions(returnValue: unknown): CapturedResolvedOptions | undefined {
  if (returnValue === null || typeof returnValue !== 'object') return undefined;
  const r = returnValue as { resolvedOptions?: unknown };
  if (r.resolvedOptions === undefined) return undefined;
  return r.resolvedOptions as CapturedResolvedOptions;
}

function writeExpectedReturn(fixture: Fixture, observed: unknown): void {
  // Round-trip through the YAML parser so the output preserves the author's
  // top-level key order + comments where possible. `yaml`'s toJS/stringify
  // drops comments, but downstream formatters can re-indent; a git diff
  // reviewer will still see the intent.
  const doc = parseYaml(readFileSync(fixture.__file, 'utf-8'));

  // expected_return tokens are not honoured by the comparator (see
  // fixture.schema.json:38) but an author may still have written one by
  // mistake. Overwriting the token with a concrete value locks the fixture
  // to a single observation and loses the (presumably intentional) wildcard.
  // Refuse the write and surface the location so the author can fix it.
  const existingTokens = findTokenPaths(doc.expected_return as unknown, 'expected_return');
  if (existingTokens.length > 0) {
    throw new Error(
      `[${fixture.name}] refusing UPDATE_PARITY_FIXTURES=1 rewrite: existing expected_return contains token(s):\n  - ${existingTokens.join('\n  - ')}\n` +
        `Tokens in expected_return are not compared by the runner (schema says so). ` +
        `If you really want to regenerate, remove the token(s) by hand first.`,
    );
  }

  doc.expected_return = observed as never;
  writeFileSync(
    fixture.__file,
    stringifyYaml(doc, { lineWidth: 100, nullStr: 'null' }),
    'utf-8',
  );
}

function findTokenPaths(value: unknown, path: string): string[] {
  if (typeof value === 'string' && isToken(value)) return [`${path} = "${value}"`];
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findTokenPaths(v, `${path}[${i}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      findTokenPaths(v, `${path}.${k}`),
    );
  }
  return [];
}
