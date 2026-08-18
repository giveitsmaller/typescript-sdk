import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import {
  ENVIRONMENT_ENDPOINTS,
  ENVIRONMENT_STREAM_ENDPOINTS,
} from '../../src/credentials.js';

/**
 * Stream-host declaration guard (card `VUozk5Bc`).
 *
 * The SSE stream lives on a SECOND host. `ENVIRONMENT_STREAM_ENDPOINTS` is the
 * SDK's hand-maintained projection of the contract's declaration — hand-held
 * because the SDK ships a browser entry point and does not load
 * `availability.json` at runtime, the same shape as the preset planned gate and
 * the watermark gate.
 *
 * A hand table without a gate is a guess that ages. THIS SUITE IS THE GATE, and
 * it fails CLOSED IN BOTH DIRECTIONS:
 *
 *   1. every host we ship is one the contract actually declares — we cannot
 *      invent a hostname (the failure mode that put prod on the gateway path
 *      was a hostname nobody declared), and
 *   2. every host the contract declares for a NAMED ENVIRONMENT is one we ship —
 *      so when the prod stream host finally lands in the contract, this test
 *      goes red on the re-vendor instead of the SDK quietly continuing to have
 *      no prod stream host.
 *
 * (2) is the one that earns its keep. Without it the missing prod entry stays
 * missing silently for exactly as long as nobody thinks to look.
 */

const require = createRequire(import.meta.url);

interface DeclaredServer {
  url?: string;
}
interface Availability {
  endpoints?: Record<string, { servers?: DeclaredServer[] }>;
}

const availability = JSON.parse(
  readFileSync(require.resolve('@giveitsmaller/contracts/availability/availability.json'), 'utf8'),
) as Availability;

const STREAM_ENDPOINT_KEY = 'GET /api/workflows/{id}/events';

/** Every stream host the vendored contract declares, in declaration order. */
function declaredServerUrls(): string[] {
  const servers = availability.endpoints?.[STREAM_ENDPOINT_KEY]?.servers ?? [];
  return servers
    .map((s) => s.url)
    .filter((url): url is string => typeof url === 'string' && url.length > 0);
}

/**
 * Contract-declared hosts that belong to a NAMED environment. `localhost` is
 * deliberately excluded: the contract declares it as a development server, but
 * there is no `localhost` value in `Environment`, so it is not something the
 * environment table can carry. Local callers pass `{streamBaseUrl}` instead.
 */
function declaredNonLocalServerUrls(): string[] {
  return declaredServerUrls().filter((url) => !/^https?:\/\/localhost(:|\/|$)/.test(url));
}

describe('ENVIRONMENT_STREAM_ENDPOINTS conformance with availability.json', () => {
  it('the contract declares stream servers for the events endpoint at all', () => {
    // Positive control. Every assertion below is a subset/superset check
    // against this list, and all of them pass vacuously if the endpoint entry
    // disappears or is renamed — which is exactly what a re-vendor could do.
    const urls = declaredServerUrls();
    expect(urls.length).toBeGreaterThan(0);
    expect(availability.endpoints?.[STREAM_ENDPOINT_KEY]).toBeDefined();
  });

  it('ships no stream host the contract does not declare', () => {
    const declared = new Set(declaredServerUrls());
    for (const [environment, url] of Object.entries(ENVIRONMENT_STREAM_ENDPOINTS)) {
      expect(
        declared.has(url),
        `ENVIRONMENT_STREAM_ENDPOINTS.${environment} = ${url} is not declared by the contract. ` +
          `Declared: ${[...declared].join(', ')}. The SDK must not invent a stream hostname.`,
      ).toBe(true);
    }
  });

  it('ships every non-localhost stream host the contract declares', () => {
    const shipped = new Set(Object.values(ENVIRONMENT_STREAM_ENDPOINTS));
    for (const url of declaredNonLocalServerUrls()) {
      expect(
        shipped.has(url),
        `The contract declares stream host ${url} but ENVIRONMENT_STREAM_ENDPOINTS does not ship it. ` +
          'If this is the production stream host finally landing, add it to the table (BOTH languages) ' +
          'in this same change — that is what this assertion exists to catch.',
      ).toBe(true);
    }
  });

  it('keys the stream table only with known environment names', () => {
    for (const environment of Object.keys(ENVIRONMENT_STREAM_ENDPOINTS)) {
      expect(Object.keys(ENVIRONMENT_ENDPOINTS)).toContain(environment);
    }
  });

  it('pins that production has NO declared stream host yet', () => {
    // This assertion is written to FAIL when the gap closes, on purpose. It is
    // the tripwire for the one prerequisite this card cannot close itself: the
    // contract's stream `servers` block carries localhost + staging only.
    //
    // WHEN THIS GOES RED, that is the good news — the prod entry has landed.
    // Add `prod` to ENVIRONMENT_STREAM_ENDPOINTS in BOTH languages, and delete
    // this test. Do NOT relax it to keep the suite green: a client falling back
    // to the API host in prod is the exact failure VUozk5Bc exists to prevent,
    // and this is the only thing that will tell anyone the wait is over.
    expect(ENVIRONMENT_STREAM_ENDPOINTS.prod).toBeUndefined();
    expect(declaredNonLocalServerUrls()).not.toContain('https://stream.giveitsmaller.com');
  });
});
