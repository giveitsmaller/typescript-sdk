import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';

import { loadFixtures, isToken, type Fixture } from './fixtures.js';
import { createFetchStub, type FetchStub } from './fetch-stub.js';
import { compareRequests, compareValue } from './comparators.js';
import { invokeFixture } from './invoke.js';

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
    it(fixture.description ?? fixture.name, async () => {
      if (fixture.mode === 'webhook') {
        // Webhook mode makes no HTTP calls; invoke directly.
        const { returnValue } = await invokeFixture(fixture);
        expect(returnValue, `fixture ${fixture.name}: verifyWebhook returned false`).toBe(true);
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
    });
  });
});

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
