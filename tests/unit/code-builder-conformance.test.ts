import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { KNOWN_WIRE_FIELDS } from '../../src/ergonomic/preset_resolver.js';
import { IMAGE_OUTPUT_ROUTES, tokenForMime } from '../../src/ergonomic/image_output_routes.js';

/**
 * Code-builder compress conformance gate (card 0fNO60BX — folds Y4Fsl3Sk).
 *
 * The hand-maintained compress `KNOWN_WIRE_FIELDS` allowlists only prevented BOGUS
 * fields — they never PROVED every contract compress option the contract intends the
 * SDK to expose is actually reachable via some ergonomic verb (the Y4Fsl3Sk drift
 * class: a new contract option silently un-exposed). This suite closes that, driven
 * from the contract-authored `code-builder-metadata.json` sidecar (the SDK+FE shared
 * `sdk_exposure` gate — drift-proof) rather than the SDK's own guess at availability.
 *
 * It is the SINGLE source of truth for compress option classification (the compress
 * block of `wire-key-conformance.test.ts` was removed in this ticket). Mirrored by the
 * PHP `CodeBuilderConformanceTest`.
 *
 * Kept browser-safe like the other gates: the SDK-side buckets below are hand tables;
 * the JSON is read ONLY here in Node/vitest, never by runtime ergonomic src.
 *
 * SCOPE: this is an option-KEY level gate operating on WIRE keys (snake_case). Two
 * axes are OUT OF SCOPE:
 *   - Enum VALUE-level exposure (`value_exposure` / `per_value_availability`, e.g.
 *     `output_format: original` vs a planned value) — owned by the per-value machinery
 *     (`isPlannedValue`, the output-route planned cells).
 *   - SURFACE-key ↔ wire resolution: the metadata declares a camelCase `surface_key`
 *     (what a frontend-generated snippet types, e.g. `trimStart`); this gate does NOT
 *     assert the SDK's alias map (`WIRE_ALIASES`) translates every `surface_key` to its
 *     wire key. That is a distinct conformance axis (SDK↔metadata naming) tracked in the
 *     follow-up ticket 3v4SKGvG — the `WIRE_ALIASES` map does not cover a few camel
 *     surface keys (e.g. `trimStart`/`trimEnd`) today.
 */

const require = createRequire(import.meta.url);

interface CbOption {
  readonly origin: string;
  readonly sdk_exposure: string;
  readonly availability?: string;
  readonly surface_key: string;
}
interface CbMediaGroup {
  readonly media_group: string;
  readonly mimes: readonly string[];
  readonly options: Readonly<Record<string, CbOption>>;
}
interface CbOperation {
  readonly media_groups: Readonly<Record<string, CbMediaGroup>>;
}
interface CodeBuilderMetadata {
  readonly operations: Readonly<Record<string, CbOperation>>;
}

const metadata = JSON.parse(
  readFileSync(
    require.resolve('@giveitsmaller/contracts/code-builder/code-builder-metadata.json'),
    'utf8',
  ),
) as CodeBuilderMetadata;

const compress = metadata.operations.compress;
const convert = metadata.operations.convert;

// The SDK folds the six `image*` contract groups into ONE `image` SDK media
// (compress is format-agnostic); every other contract group maps 1:1.
const sdkMediaFor = (group: string): string => (group.startsWith('image') ? 'image' : group);

// IN-SCOPE = the options the contract says the SDK should expose. Every compress
// option is `origin: contract` (no sdk_render_hint), so this reduces to `expose`.
const isInScope = (o: CbOption): boolean => o.origin === 'contract' && o.sdk_exposure === 'expose';

const knownFor = (media: string): ReadonlySet<string> =>
  (KNOWN_WIRE_FIELDS as Readonly<Record<string, ReadonlySet<string>>>)[media] ?? new Set<string>();

// ---------------------------------------------------------------------------
// SDK-side classification tables (browser-safe hand tables; test-local).
// ---------------------------------------------------------------------------

/**
 * CROSS_VERB_ROUTING: compress-catalog options the ergonomic `compress()` verb does
 * NOT emit because they are surfaced by a DIFFERENT verb. Keyed by SDK media → wire
 * key → target verb. Self-verified below against the real verb surfaces, so this map
 * cannot lie (a wrong entry fails the reachability test).
 *   - image raster knobs → output() (resize width/height/fit is sugar over output;
 *     per-format knobs progressive/optimization_level/avif_speed ARE output() options).
 *   - audio/video output_format → convert() (format change is a convert concern).
 * v1 map is SDK-side; the contract render_verb tag (fast-follow 2lINYb2D) is not in v1.
 */
const CROSS_VERB_ROUTING: Readonly<Record<string, Readonly<Record<string, 'output' | 'convert'>>>> = {
  image: {
    width: 'output', height: 'output', fit: 'output',
    lossless: 'output', encoding_mode: 'output', target_size_bytes: 'output',
    chroma_subsampling: 'output', quality_preset: 'output',
    color_profile: 'output', auto_orient: 'output',
    progressive: 'output', optimization_level: 'output', avif_speed: 'output',
  },
  audio: { output_format: 'convert' },
  video: { output_format: 'convert' },
};

/**
 * DEFERRED_EXPOSURE: expose+contract compress options reachable by NO ergonomic verb
 * today. Exposing them is new ergonomic public API (product-scope) — tracked in the
 * follow-up ticket; deferred (not exposed) here. Drift-guarded below (each must stay
 * expose+contract AND genuinely unreachable).
 */
const DEFERRED_EXPOSURE: Readonly<Record<string, readonly string[]>> = {
  document_pdf: ['quality', 'image_dpi'],
  document_office: ['quality'],
  document_odf: ['quality'],
  document_epub: ['quality'],
};

/**
 * PRE_EXPOSED: keys the SDK's `KNOWN_WIRE_FIELDS` ALLOWS ahead of the contract — the
 * contract marks them `coming_soon` (worker not ready), but the SDK's document-compress
 * presets emit them. Documented + drift-guarded (must stay `coming_soon`); reconciling
 * them (stop emitting, or contract flips to expose) is tracked in the follow-up ticket.
 */
const PRE_EXPOSED: Readonly<Record<string, readonly string[]>> = {
  document_office: ['strip_macros', 'strip_hidden_data', 'strip_unused_fonts'],
  document_odf: ['strip_metadata', 'strip_unused_styles'],
  document_epub: ['font_subsetting', 'strip_unused_css'],
};

// The contract's own availability → sdk_exposure derivation (build-code-builder-metadata.py):
// {stable, beta} → expose; experimental → expose_optin; planned → coming_soon;
// deprecated → deprecated. Absent availability ⇒ stable ⇒ expose.
const EXPOSURE_BY_AVAILABILITY: Readonly<Record<string, string>> = {
  stable: 'expose', beta: 'expose',
  experimental: 'expose_optin',
  planned: 'coming_soon',
  deprecated: 'deprecated',
};

type Bucket = 'native' | 'routing' | 'deferred' | 'uncovered';

/** Classify a compress `(contract group, wire key)` into exactly one SDK bucket. */
function classify(group: string, wireKey: string): Bucket {
  const media = sdkMediaFor(group);
  if (knownFor(media).has(wireKey)) return 'native';
  if (CROSS_VERB_ROUTING[media]?.[wireKey] !== undefined) return 'routing';
  if ((DEFERRED_EXPOSURE[media] ?? []).includes(wireKey)) return 'deferred';
  return 'uncovered';
}

/** Wire keys reachable for a contract group via EVERY applicable ergonomic surface. */
function mediaReachableKeys(group: string): Set<string> {
  const media = sdkMediaFor(group);
  const reachable = new Set<string>(knownFor(media));
  if (media === 'image') {
    for (const mime of compress.media_groups[group]!.mimes) {
      const token = tokenForMime(mime);
      const cell = token ? IMAGE_OUTPUT_ROUTES.same_format[token] : undefined;
      if (cell) for (const k of cell.honored) reachable.add(k);
    }
    reachable.add('output_format'); // convert()
  } else if (media === 'audio' || media === 'video') {
    reachable.add('output_format'); // convert()
  }
  return reachable;
}

/** Every compress `(group, key)` whose option is in-scope (expose+contract). */
function inScopeEntries(): Array<{ group: string; key: string; opt: CbOption }> {
  const out: Array<{ group: string; key: string; opt: CbOption }> = [];
  for (const [group, mg] of Object.entries(compress.media_groups)) {
    for (const [key, opt] of Object.entries(mg.options)) {
      if (isInScope(opt)) out.push({ group, key, opt });
    }
  }
  return out;
}

describe('code-builder compress conformance', () => {
  // Assertion 4 — the two contract signals agree, pinning the new sdk_exposure ledger
  // to the older availability one so a regen can't diverge them. Also asserts the
  // IN-SCOPE == `expose` simplification holds (no expose_optin exists yet).
  it('every compress option: availability maps to sdk_exposure, and no expose_optin exists', () => {
    let exposeOptinCount = 0;
    for (const mg of Object.values(compress.media_groups)) {
      for (const [key, opt] of Object.entries(mg.options)) {
        const availability = opt.availability ?? 'stable';
        const expected = EXPOSURE_BY_AVAILABILITY[availability];
        expect(
          expected,
          `unknown availability '${availability}' for compress option '${key}'`,
        ).toBeDefined();
        expect(
          opt.sdk_exposure,
          `compress '${key}': availability '${availability}' should derive sdk_exposure ` +
            `'${expected}' but metadata says '${opt.sdk_exposure}'`,
        ).toBe(expected);
        if (opt.sdk_exposure === 'expose_optin') exposeOptinCount += 1;
      }
    }
    // IN-SCOPE == expose relies on there being no expose_optin compress option. If this
    // fails, a beta/experimental option shipped — extend the gate to handle expose_optin.
    expect(exposeOptinCount, 'expose_optin compress options exist — extend the gate').toBe(0);
  });

  // Assertion 1 — every expose+contract compress option is in EXACTLY one SDK bucket.
  // An option in NO bucket is the Y4Fsl3Sk drift (a new contract option the SDK does
  // not expose and has not deliberately deferred) — it fails HERE.
  it('every in-scope compress option is classified into exactly one bucket', () => {
    const uncovered = inScopeEntries()
      .filter(({ group, key }) => classify(group, key) === 'uncovered')
      .map(({ group, key }) => `${group}.${key}`);
    expect(
      uncovered,
      `expose+contract compress option(s) reachable by no SDK bucket (native/routing/deferred): ` +
        `${JSON.stringify(uncovered)}. Expose them, route them, or add to DEFERRED_EXPOSURE.`,
    ).toEqual([]);
  });

  // The three SDK buckets must be pairwise disjoint per media (no key double-counted).
  it('COMPRESS_NATIVE / CROSS_VERB_ROUTING / DEFERRED_EXPOSURE are pairwise disjoint per media', () => {
    const medias = new Set<string>(Object.keys(compress.media_groups).map(sdkMediaFor));
    for (const media of medias) {
      const native = new Set(knownFor(media));
      const routing = new Set(Object.keys(CROSS_VERB_ROUTING[media] ?? {}));
      const deferred = new Set(DEFERRED_EXPOSURE[media] ?? []);
      const overlaps: string[] = [];
      for (const k of native) if (routing.has(k) || deferred.has(k)) overlaps.push(`${media}.${k}`);
      for (const k of routing) if (deferred.has(k)) overlaps.push(`${media}.${k}`);
      expect(overlaps, `bucket overlap for media '${media}': ${JSON.stringify(overlaps)}`).toEqual([]);
    }
  });

  // Existence guard for CROSS_VERB_ROUTING (mirrors the DEFERRED/PRE_EXPOSED guards):
  // assertion 2a only honored-checks routing keys that are IN-SCOPE, so a stale/typo'd
  // routing entry whose key is no longer expose+contract (e.g. a key that regressed to
  // coming_soon) would sit unvalidated. Pin every routing entry to a real expose+contract
  // compress option for its media, so the map genuinely "cannot lie".
  it('every CROSS_VERB_ROUTING entry is a real expose+contract compress option for its media', () => {
    const inScopeByMedia = new Map<string, Set<string>>();
    for (const { group, key } of inScopeEntries()) {
      const media = sdkMediaFor(group);
      if (!inScopeByMedia.has(media)) inScopeByMedia.set(media, new Set());
      inScopeByMedia.get(media)!.add(key);
    }
    for (const [media, routes] of Object.entries(CROSS_VERB_ROUTING)) {
      for (const key of Object.keys(routes)) {
        expect(
          inScopeByMedia.get(media)?.has(key) ?? false,
          `CROSS_VERB_ROUTING['${media}']['${key}'] is not an expose+contract compress option for ` +
            `'${media}' — a stale/typo'd routing entry the honored-check silently skips.`,
        ).toBe(true);
      }
    }
  });

  // Assertion 2a — routed keys are actually reachable through their target verb, on the
  // ACTUAL media/route (per-format for images, media-scoped for convert). This is what
  // prevents a wrong routing entry (or a per-format masking gap) from silently passing.
  it('cross-verb routed keys are honored by their target verb on every applicable route', () => {
    for (const { group, key } of inScopeEntries()) {
      if (classify(group, key) !== 'routing') continue;
      const media = sdkMediaFor(group);
      const verb = CROSS_VERB_ROUTING[media]![key]!;
      if (verb === 'output') {
        // Must be honored on EVERY format token the raw group covers (base `image`
        // group = gif+tiff, so a key honored only on one token is NOT sufficient).
        for (const mime of compress.media_groups[group]!.mimes) {
          const token = tokenForMime(mime);
          expect(token, `unknown image mime '${mime}' in group '${group}'`).toBeDefined();
          const cell = IMAGE_OUTPUT_ROUTES.same_format[token!];
          expect(cell, `no same_format route for token '${token}'`).toBeDefined();
          expect(
            cell!.honored,
            `${group}.${key} routes to output() but is not honored on the '${token}' route`,
          ).toContain(key);
        }
      } else {
        // convert(): media-scoped — the convert op must expose this key for THIS media
        // group (not merely somewhere op-wide).
        const convertGroup = convert.media_groups[group];
        expect(convertGroup, `convert has no '${group}' media group`).toBeDefined();
        expect(
          Object.keys(convertGroup!.options),
          `${group}.${key} routes to convert() but convert.${group} does not expose it`,
        ).toContain(key);
      }
    }
  });

  // Assertion 2b — deferred keys must be reachable by NONE of their media's ergonomic
  // surfaces. Media-scoped so a shared key like `quality` (a valid image output() key,
  // but a genuine gap for documents) does not collide. This self-corrects a
  // misclassification: an image key wrongly placed in DEFERRED IS in the output surface
  // and fails here.
  it('deferred keys are reachable by no ergonomic surface for their media', () => {
    for (const [media, keys] of Object.entries(DEFERRED_EXPOSURE)) {
      // Find a representative contract group for this SDK media (documents map 1:1).
      const group = Object.keys(compress.media_groups).find((g) => sdkMediaFor(g) === media);
      expect(group, `no compress contract group maps to SDK media '${media}'`).toBeDefined();
      const reachable = mediaReachableKeys(group!);
      for (const key of keys) {
        expect(
          reachable.has(key),
          `deferred '${media}.${key}' IS reachable via an ergonomic surface — it is not a ` +
            `genuine gap; reclassify it as native/routing.`,
        ).toBe(false);
        // And it must genuinely be an expose+contract option (else remove it).
        const opt = compress.media_groups[group!]!.options[key];
        expect(opt, `deferred '${media}.${key}' is not a contract option`).toBeDefined();
        expect(isInScope(opt!), `deferred '${media}.${key}' is no longer expose+contract`).toBe(true);
      }
    }
  });

  // Assertion 3 — exact-gate the allowlist in the reverse direction: every emit-allowed
  // key is either `expose` OR a documented, drift-guarded `coming_soon` pre-exposure.
  // Catches a NEW coming_soon key sneaking into KNOWN_WIRE_FIELDS, or an expose→deprecated flip.
  it('every KNOWN_WIRE_FIELDS key is expose, or a drift-guarded PRE_EXPOSED coming_soon key', () => {
    // Build media → { wireKey → sdk_exposure } from the metadata (image family folds).
    const exposureByMediaKey = new Map<string, string>();
    for (const [group, mg] of Object.entries(compress.media_groups)) {
      const media = sdkMediaFor(group);
      for (const [key, opt] of Object.entries(mg.options)) {
        // Prefer an `expose` reading if any image-family group exposes the key.
        const cur = exposureByMediaKey.get(`${media}.${key}`);
        if (cur === undefined || opt.sdk_exposure === 'expose') {
          exposureByMediaKey.set(`${media}.${key}`, opt.sdk_exposure);
        }
      }
    }
    for (const media of Object.keys(KNOWN_WIRE_FIELDS)) {
      for (const key of knownFor(media)) {
        const exposure = exposureByMediaKey.get(`${media}.${key}`);
        expect(exposure, `KNOWN_WIRE_FIELDS['${media}'] key '${key}' is not a compress contract option`).toBeDefined();
        if (exposure === 'expose') continue;
        expect(
          (PRE_EXPOSED[media] ?? []).includes(key),
          `KNOWN_WIRE_FIELDS['${media}'] key '${key}' is '${exposure}' (not expose) and not in ` +
            `PRE_EXPOSED — the SDK emits a field the contract has not exposed. Reconcile or document it.`,
        ).toBe(true);
        expect(
          exposure,
          `PRE_EXPOSED['${media}'] key '${key}' is no longer 'coming_soon' (got '${exposure}') — re-evaluate.`,
        ).toBe('coming_soon');
      }
    }
    // Every PRE_EXPOSED entry must actually be an allow-listed key (no stale entries).
    for (const [media, keys] of Object.entries(PRE_EXPOSED)) {
      for (const key of keys) {
        expect(knownFor(media).has(key), `PRE_EXPOSED['${media}'] key '${key}' is not in KNOWN_WIRE_FIELDS`).toBe(true);
      }
    }
  });

  // Assertion 5 — negative controls proving the gate is not tautological. These stay
  // meaningful even after the follow-up ticket empties PRE_EXPOSED / DEFERRED_EXPOSURE
  // (which would otherwise make assertions 2b/3's non-expose branches vacuous).
  it('negative control: the partition, reverse, and reachability checks all have teeth', () => {
    // (a) uncovered: a new expose+contract option in no bucket is flagged.
    expect(classify('audio', '__synthetic_unexposed_key__')).toBe('uncovered');

    // (c) per-format strictness: `progressive` is jpeg-only; the base `image` group's gif
    // route does NOT honor it — so routing it under the multi-token base group would fail
    // the honored-on-every-token check.
    expect(IMAGE_OUTPUT_ROUTES.same_format.gif!.honored).not.toContain('progressive');
    expect(IMAGE_OUTPUT_ROUTES.same_format.jpeg!.honored).toContain('progressive');

    // (b) reverse exact-gate: a `coming_soon` KNOWN_WIRE_FIELDS key must be REJECTED unless
    // it is in PRE_EXPOSED. Pin the predicate directly so it survives PRE_EXPOSED shrinking.
    const knownKeyAcceptable = (media: string, key: string, exposure: string): boolean =>
      exposure === 'expose' || (PRE_EXPOSED[media] ?? []).includes(key);
    expect(knownKeyAcceptable('image', '__synthetic_coming_soon_key__', 'coming_soon')).toBe(false);
    expect(knownKeyAcceptable('document_office', 'strip_macros', 'coming_soon')).toBe(true);
    expect(knownKeyAcceptable('image', 'quality', 'expose')).toBe(true);

    // (d) reachability has teeth: a routed image key (width → output()) IS in the reachable
    // set, so a DEFERRED entry that is actually reachable would be caught by assertion 2b.
    const rasterImageGroup = Object.keys(compress.media_groups).find(
      (g) => sdkMediaFor(g) === 'image' && compress.media_groups[g]!.mimes.some((m) => tokenForMime(m) !== 'svg'),
    );
    expect(rasterImageGroup, 'a raster image compress group exists').toBeDefined();
    expect(mediaReachableKeys(rasterImageGroup!).has('width')).toBe(true);
  });
});
