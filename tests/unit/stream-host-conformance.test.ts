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
  /**
   * The API host this stream host stands in FOR. The contract declares the
   * pairing; nothing in the hostname does. See the pairing suite at the bottom
   * of this file for why reading it matters.
   */
  replaces?: string;
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
});

/**
 * PAIRING — the half the set checks above cannot express (e2e, 2026-09-15).
 *
 * The four assertions above compare SETS of hosts, in both directions. Every
 * one of them still passes if `prod` and `staging` are SWAPPED: the same two
 * hostnames are shipped and the same two are declared. And a swap is not a
 * cosmetic error — it sends a credentialed stream request to the wrong
 * environment.
 *
 * e2e hit this from outside: forced to supply `streamBaseUrl` (the low-level
 * client fails closed, by design), they copied our two pairs and guarded the
 * copy by reading our shipped `dist` AS TEXT. Their guard has the identical
 * blind spot, and they said so rather than shipping it quietly.
 *
 * ⭐ THE CONTRACT ALREADY CARRIES THE PAIRING AND NOTHING READ IT. Each declared
 * server has a `replaces` field naming the API host it stands in for. So the
 * pairing is a DECLARED FACT, not a naming convention — which matters, because
 * the alternative (assert `stream.X` matches `api.X` by string shape) is the
 * derive-don't-declare mistake this whole table exists to prevent, one layer up.
 */
describe('environment pairing, read from the contract rather than from hostnames', () => {
  it('declares a replaces target for every non-localhost stream server', () => {
    // Positive control for the field itself: every assertion below is a lookup
    // keyed on `replaces`, and all of them would pass vacuously if a re-vendor
    // dropped it.
    const servers = availability.endpoints?.[STREAM_ENDPOINT_KEY]?.servers ?? [];
    const nonLocal = servers.filter(
      (s) => typeof s.url === 'string' && !/^https?:\/\/localhost(:|\/|$)/.test(s.url),
    );
    expect(nonLocal.length).toBeGreaterThan(0);
    for (const server of nonLocal) {
      expect(
        typeof server.replaces === 'string' && server.replaces.length > 0,
        `contract server ${server.url} declares no 'replaces' — the pairing this suite ` +
          'checks is no longer stated, so a swapped table would go undetected.',
      ).toBe(true);
    }
  });

  it('pairs each environment stream host with that environment API host', () => {
    const servers = availability.endpoints?.[STREAM_ENDPOINT_KEY]?.servers ?? [];

    for (const [environment, streamUrl] of Object.entries(ENVIRONMENT_STREAM_ENDPOINTS)) {
      const apiUrl = ENVIRONMENT_ENDPOINTS[environment as keyof typeof ENVIRONMENT_ENDPOINTS];
      const declared = servers.find((s) => s.url === streamUrl);

      expect(declared, `no contract server declares ${streamUrl}`).toBeDefined();
      expect(
        declared?.replaces,
        `PAIRING MISMATCH for '${environment}': the SDK pairs stream host ${streamUrl} with API ` +
          `host ${apiUrl}, but the contract declares that stream host as replacing ` +
          `${declared?.replaces}. Two environments' hosts have been crossed — a caller resolving ` +
          `'${environment}' would send credentialed stream requests to the other environment.`,
      ).toBe(apiUrl);
    }
  });
});

/**
 * PUBLIC SURFACE — these two tables are exported from the package barrel, so a
 * consumer forced onto the low-level surface can read the declaration instead of
 * hard-coding hosts.
 */
describe('the exported endpoint tables', () => {
  it('exports the SAME objects the resolver reads, not copies', async () => {
    // A copy would be worse than no export: it would look authoritative and
    // could drift from the table that actually decides where requests go —
    // which is the defect being fixed, reproduced inside the fix.
    const barrel = await import('../../src/index.core.js');
    expect(barrel.ENVIRONMENT_ENDPOINTS).toBe(ENVIRONMENT_ENDPOINTS);
    expect(barrel.ENVIRONMENT_STREAM_ENDPOINTS).toBe(ENVIRONMENT_STREAM_ENDPOINTS);
  });

  it('freezes both, so a consumer cannot repoint the SDK by mutating them', () => {
    // Sharing the live objects is what makes the export honest; freezing is what
    // makes sharing safe. Test modules are ES modules, so mutation THROWS here
    // rather than failing silently.
    expect(Object.isFrozen(ENVIRONMENT_ENDPOINTS)).toBe(true);
    expect(Object.isFrozen(ENVIRONMENT_STREAM_ENDPOINTS)).toBe(true);
    expect(() => {
      (ENVIRONMENT_STREAM_ENDPOINTS as Record<string, string>).prod = 'https://evil.example';
    }).toThrow(TypeError);
    expect(ENVIRONMENT_STREAM_ENDPOINTS.prod).toBe('https://stream.giveitsmaller.com');
  });
});
