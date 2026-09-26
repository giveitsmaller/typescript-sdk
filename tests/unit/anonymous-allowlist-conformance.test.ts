import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { ANONYMOUS_ALLOWLIST, gisl } from '../../src/gisl.js';
import type { GislClient } from '../../src/client.js';
import { GislFeatureRequiresAuthError } from '../../src/errors.js';

/**
 * OuegCUtq — the anonymous allowlist is PINNED TO THE CONTRACT, in both
 * directions (owner decision 610(4): the API is the source of truth).
 *
 *   (a) every allowlisted client method reaches ONLY endpoints the vendored
 *       `availability.json` marks `auth: optional` or `anonymous`;
 *   (b) every endpoint the contract marks non-`required` is reached by an
 *       allowlisted method, or is named in ENDPOINT_EXCLUSIONS with a reason;
 *       and every EXCLUDED method still reaches a `required` endpoint unless it
 *       is a named policy exclusion — so a contract that opens an endpoint to
 *       guests turns this red instead of leaving the SDK silently narrower.
 *
 * The method -> endpoint tables are hand-maintained from reading `client.ts`.
 * They are typed against `GislClient`, so a public method nobody classified is
 * a COMPILE error (`npm run check:tests`), not a silent pass.
 */

const require = createRequire(import.meta.url);

type AuthLevel = 'required' | 'optional' | 'anonymous';
interface Availability {
  endpoints: Record<string, { auth: AuthLevel; operation_id?: string }>;
}

const availability = JSON.parse(
  readFileSync(require.resolve('@giveitsmaller/contracts/availability/availability.json'), 'utf8'),
) as Availability;

type AllowlistedMethod = (typeof ANONYMOUS_ALLOWLIST)[number];
type PublicMethod<T> = { [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never }[keyof T];
type ExcludedMethod = Exclude<PublicMethod<GislClient>, AllowlistedMethod>;

/**
 * Every endpoint each allowlisted method can reach ON AN ANONYMOUS CLIENT.
 * `uploadFile` reaches only single-shot: the gate refuses anything above the
 * single-shot cap and any resume before a request, so the multipart endpoints
 * are unreachable (and the API requires auth on them anyway; see
 * ENDPOINT_EXCLUSIONS). `maybeWaitForVideoProbe` reaches nothing: the gate makes
 * it a no-op, because the probe endpoint is `required`.
 * `createWorkflowAwaitingProbe` re-enters the gate for its probe wait, so it
 * reaches only the create.
 */
const METHOD_ENDPOINTS: Record<AllowlistedMethod, readonly string[]> = {
  uploadFile: ['POST /api/uploads'],
  getMetadata: ['GET /api/uploads/{id}/metadata'],
  createWorkflow: ['POST /api/workflows'],
  createWorkflowAwaitingProbe: ['POST /api/workflows'],
  getWorkflowStatus: ['GET /api/workflows/{id}/status'],
  waitForWorkflow: ['GET /api/workflows/{id}/status'],
  getWorkflowDownloads: ['GET /api/workflows/{id}/downloads'],
  streamEvents: ['GET /api/workflows/{id}/events'],
  getSchema: ['GET /api/operations/schema'],
  submitContact: ['POST /api/contact'],
  maybeWaitForVideoProbe: [],
};

/**
 * ⚠️ CONTRACT-VS-API DISAGREEMENTS. The contract marks these `optional`, but the
 * API requires authentication — measured 2026-09-26 in compression_api
 * `compression/config/packages/security.yaml` access_control (origin/main
 * 566d3350): `^/api/uploads/multipart/initiate$` and
 * `^/api/operations/[^/]+/retry$` are `IS_AUTHENTICATED_FULLY`. The API is the
 * source of truth for what a guest may do, so they stay off the guest surface.
 * Delete these exclusions when the contract is corrected; the stale-exclusion
 * check below goes red on its own once it is.
 */
const API_REQUIRES_AUTH_MULTIPART =
  'contract says optional, but the API requires auth on multipart initiate (security.yaml ' +
  'IS_AUTHENTICATED_FULLY), so a guest cannot start a multipart upload and complete is unreachable';
const API_REQUIRES_AUTH_RETRY =
  'contract says optional, but the API requires auth on retry (security.yaml IS_AUTHENTICATED_FULLY)';

/**
 * Every public method NOT on the allowlist, with the endpoints it reaches. The
 * reason is the contract's `required` unless `policy` says otherwise.
 */
const EXCLUDED_METHODS: Record<ExcludedMethod, { endpoints: readonly string[]; policy?: string }> = {
  getUploadStatus: { endpoints: ['GET /api/uploads/multipart/{uploadId}/status'] },
  presignParts: { endpoints: ['POST /api/uploads/multipart/{uploadId}/presign'] },
  keepaliveUpload: { endpoints: ['POST /api/uploads/multipart/{uploadId}/keepalive'] },
  cancelWorkflow: { endpoints: ['POST /api/workflows/{id}/cancel'] },
  archiveWorkflow: { endpoints: ['POST /api/workflows/{id}/archive'] },
  restoreWorkflow: { endpoints: ['POST /api/workflows/{id}/restore'] },
  resumeWorkflow: { endpoints: ['POST /api/workflows/{id}/resume'] },
  listWorkflows: { endpoints: ['GET /api/workflows'] },
  workflows: { endpoints: ['GET /api/workflows'] },
  createCheckoutSession: { endpoints: ['POST /api/billing/checkout'] },
  getCreditsBalance: { endpoints: ['GET /api/v2/credits/balance'] },
  getCreditsUsage: { endpoints: ['GET /api/v2/credits/usage'] },
  getAccountLimits: { endpoints: ['GET /api/v2/account/limits'] },
  getProfile: { endpoints: ['GET /api/auth/profile'] },
  logout: { endpoints: ['POST /api/auth/logout'] },
  createExternalImport: { endpoints: ['POST /api/external-imports'] },
  decodeAudioWatermark: { endpoints: ['POST /api/audio-watermark/decode'] },
  probeUpload: { endpoints: ['POST /api/uploads/{id}/probe'] },
  waitForProbe: { endpoints: ['POST /api/uploads/{id}/probe'] },
  preflightClips: { endpoints: ['POST /api/uploads/{id}/probe'] },
  retryOperation: {
    endpoints: ['POST /api/operations/{id}/retry'],
    policy: API_REQUIRES_AUTH_RETRY,
  },
  login: {
    endpoints: ['POST /api/auth/login'],
    policy:
      'The endpoint accepts guests, but logging in turns the client into a session client. ' +
      'An anonymous client carries no credential of any kind; to log in, use ' +
      'gisl.create({ useSessionCookie: true }).',
  },
};

/** Non-`required` endpoints no allowlisted method reaches, and why. */
const ENDPOINT_EXCLUSIONS: Record<string, string> = {
  'POST /api/uploads/multipart/initiate': API_REQUIRES_AUTH_MULTIPART,
  'POST /api/uploads/multipart/complete': API_REQUIRES_AUTH_MULTIPART,
  'POST /api/operations/{id}/retry': API_REQUIRES_AUTH_RETRY,
  'GET /healthz': 'infrastructure probe; the SDK has no method for it',
  'GET /readyz': 'infrastructure probe; the SDK has no method for it',
  'POST /api/auth/login': 'policy exclusion: see EXCLUDED_METHODS.login',
  'POST /api/auth/register': 'account lifecycle; the SDK has no method for it',
  'POST /api/auth/verify-email': 'account lifecycle; the SDK has no method for it',
  'POST /api/auth/resend-verification': 'account lifecycle; the SDK has no method for it',
  'POST /api/auth/forgot-password': 'account lifecycle; the SDK has no method for it',
  'POST /api/auth/reset-password': 'account lifecycle; the SDK has no method for it',
  'POST /api/auth/confirm-email-change': 'account lifecycle; the SDK has no method for it',
};

interface Violation {
  kind: 'unknown_endpoint' | 'allowlisted_reaches_required' | 'uncovered_endpoint' | 'stale_exclusion' | 'excluded_but_open';
  subject: string;
}

function checkAllowlist(avail: Availability): Violation[] {
  const violations: Violation[] = [];
  const authOf = (endpoint: string): AuthLevel | undefined => avail.endpoints[endpoint]?.auth;

  const reachedByAllowlist = new Set<string>();
  for (const [method, endpoints] of Object.entries(METHOD_ENDPOINTS)) {
    for (const endpoint of endpoints) {
      reachedByAllowlist.add(endpoint);
      const auth = authOf(endpoint);
      if (auth === undefined) violations.push({ kind: 'unknown_endpoint', subject: `${method} -> ${endpoint}` });
      else if (auth === 'required') violations.push({ kind: 'allowlisted_reaches_required', subject: `${method} -> ${endpoint}` });
    }
  }
  for (const [endpoint, entry] of Object.entries(avail.endpoints)) {
    if (entry.auth === 'required') continue;
    if (!reachedByAllowlist.has(endpoint) && ENDPOINT_EXCLUSIONS[endpoint] === undefined) {
      violations.push({ kind: 'uncovered_endpoint', subject: endpoint });
    }
  }
  for (const endpoint of Object.keys(ENDPOINT_EXCLUSIONS)) {
    const auth = authOf(endpoint);
    if (auth === undefined || auth === 'required') violations.push({ kind: 'stale_exclusion', subject: endpoint });
  }
  for (const [method, entry] of Object.entries(EXCLUDED_METHODS)) {
    for (const endpoint of entry.endpoints) {
      if (authOf(endpoint) === undefined) violations.push({ kind: 'unknown_endpoint', subject: `${method} -> ${endpoint}` });
    }
    const allOpen = entry.endpoints.every((e) => {
      const auth = authOf(e);
      return auth !== undefined && auth !== 'required';
    });
    if (allOpen && entry.policy === undefined) violations.push({ kind: 'excluded_but_open', subject: method });
  }
  return violations;
}

function withAuth(endpoint: string, auth: AuthLevel): Availability {
  const clone = structuredClone(availability);
  clone.endpoints[endpoint] = { ...clone.endpoints[endpoint]!, auth };
  return clone;
}

describe('anonymous allowlist vs contract endpoint auth (OuegCUtq)', () => {
  it('reads a populated endpoint table (the checks below would pass vacuously on an empty one)', () => {
    const open = Object.values(availability.endpoints).filter((e) => e.auth !== 'required');
    expect(Object.keys(availability.endpoints).length).toBeGreaterThan(20);
    expect(open.length).toBeGreaterThan(5);
  });

  it('the allowlist and the method -> endpoint table name the same methods', () => {
    expect([...ANONYMOUS_ALLOWLIST].sort()).toEqual(Object.keys(METHOD_ENDPOINTS).sort());
  });

  it('holds in both directions against the vendored contract', () => {
    expect(checkAllowlist(availability)).toEqual([]);
  });

  describe('positive controls: the check can fail', () => {
    it('an allowlisted method whose endpoint the contract makes required', () => {
      expect(checkAllowlist(withAuth('POST /api/workflows', 'required'))).toContainEqual({
        kind: 'allowlisted_reaches_required',
        subject: 'createWorkflow -> POST /api/workflows',
      });
    });

    it('an endpoint the contract opens to guests that nothing reaches', () => {
      const opened = structuredClone(availability);
      opened.endpoints['GET /api/workflows/{id}/new-thing'] = { auth: 'optional' };
      expect(checkAllowlist(opened)).toContainEqual({
        kind: 'uncovered_endpoint',
        subject: 'GET /api/workflows/{id}/new-thing',
      });
    });

    it('an excluded method whose endpoint the contract opens to guests', () => {
      expect(checkAllowlist(withAuth('POST /api/workflows/{id}/cancel', 'optional'))).toContainEqual({
        kind: 'excluded_but_open',
        subject: 'cancelWorkflow',
      });
    });

    it('an endpoint removed from the contract', () => {
      const removed = structuredClone(availability);
      delete removed.endpoints['GET /api/workflows/{id}/status'];
      expect(checkAllowlist(removed)).toContainEqual({
        kind: 'unknown_endpoint',
        subject: 'getWorkflowStatus -> GET /api/workflows/{id}/status',
      });
    });

    it('an exclusion that no longer describes an open endpoint', () => {
      expect(checkAllowlist(withAuth('POST /api/auth/register', 'required'))).toContainEqual({
        kind: 'stale_exclusion',
        subject: 'POST /api/auth/register',
      });
    });
  });
});

describe('gisl.anonymous(): every excluded method throws before any I/O', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
  });

  // Driven from the compile-checked table, so a newly added client method is
  // classified before it can be forgotten here.
  it.each(Object.keys(EXCLUDED_METHODS))('%s', async (method) => {
    const client = await gisl.anonymous({ baseUrl: 'https://api.example.com' });
    const call = (client as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!;
    let thrown: unknown;
    try {
      await call('019539ab-1111-7000-8000-000000000001');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GislFeatureRequiresAuthError);
    expect((thrown as GislFeatureRequiresAuthError).operation).toBe(method);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
