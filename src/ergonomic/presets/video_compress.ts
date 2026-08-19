// T4a — VideoCompressPresetOptions leaf DTO.
//
// Field set per ticket VhIj4S7T: video = 11 fields
//   (codec, targetSize, crf, preset, width, height, fit, fps, faststart,
//    audioCodec, audioBitrate).
// Deliberately excluded: encodingMode + targetSizeBytes (raw wire —
// replaced by ergonomic `targetSize: string|number` which the SDK derives
// at resolve time in T4b), trim_start/trim_end (per-call content selection).
//
// `targetSize` accepts `string` (e.g. "50MB") or `number` (bytes). The
// resolver in T4b converts to the wire `target_size_bytes` and sets
// `encoding_mode: target_size` accordingly.

import {
  VideoCodec,
  VideoPreset,
  VideoFit,
  AudioCodec,
  AudioBitrate,
  OptimizeFor,
} from '../../generated/sdk_spec/enums.js';
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';
import { translateEnum } from './_translate.js';

export interface VideoCompressPresetOptionsInput {
  readonly codec?: VideoCodec;
  /**
   * Target output size (`'50MB'`-style string — BINARY units, 1 KB = 1024 — or a byte
   * count). Derived by the resolver into `target_size_bytes` + `encoding_mode:
   * 'target_size'`.
   *
   * **NOT AVAILABLE FOR LONG INPUTS.** A compress whose input duration routes to the
   * long-form path rejects it (`reject_long_form_target_size`): that path is
   * single-pass-CRF by construction and two-pass target-size is unbuilt. The request
   * fails during execution, and the SDK cannot warn earlier — routing is decided
   * server-side at create-plan time, so there is nothing here to check it against.
   * The same limit applies to {@link MergeOptions.targetSize}.
   * Short-form compresses honour it normally.
   *
   * The contract CAN now express this — `per_class_availability` scopes an option to
   * a processing class, vendored at v2.195.0 and pinned by
   * `tests/unit/per-class-availability-conformance.test.ts`. That buys an honest 422
   * from the API at CREATE rather than a job dying mid-execution; it does NOT become
   * a client-side gate, because routing is still decided server-side and a duration
   * heuristic here would be wrong at the boundary. Tracked by `zJN6XIi5`.
   */
  readonly targetSize?: string | number;
  readonly crf?: number;
  readonly preset?: VideoPreset;
  readonly width?: number;
  readonly height?: number;
  readonly fit?: VideoFit;
  readonly fps?: number;
  readonly faststart?: boolean;
  readonly audioCodec?: AudioCodec;
  readonly audioBitrate?: AudioBitrate;
}

export class VideoCompressPresetOptions {
  readonly codec?: VideoCodec;
  readonly targetSize?: string | number;
  readonly crf?: number;
  readonly preset?: VideoPreset;
  readonly width?: number;
  readonly height?: number;
  readonly fit?: VideoFit;
  readonly fps?: number;
  readonly faststart?: boolean;
  readonly audioCodec?: AudioCodec;
  readonly audioBitrate?: AudioBitrate;

  private constructor(input: VideoCompressPresetOptionsInput) {
    if (input.codec !== undefined) this.codec = input.codec;
    if (input.targetSize !== undefined) this.targetSize = input.targetSize;
    if (input.crf !== undefined) this.crf = input.crf;
    if (input.preset !== undefined) this.preset = input.preset;
    if (input.width !== undefined) this.width = input.width;
    if (input.height !== undefined) this.height = input.height;
    if (input.fit !== undefined) this.fit = input.fit;
    if (input.fps !== undefined) this.fps = input.fps;
    if (input.faststart !== undefined) this.faststart = input.faststart;
    if (input.audioCodec !== undefined) this.audioCodec = input.audioCodec;
    if (input.audioBitrate !== undefined) this.audioBitrate = input.audioBitrate;
    Object.freeze(this);
  }

  static from(input: VideoCompressPresetOptionsInput): VideoCompressPresetOptions {
    return new VideoCompressPresetOptions(input);
  }

  static shippedDefaultsFor(level: OptimizeFor): VideoCompressPresetOptions {
    const cell = f3ShippedDefaultsFor('video_compress', level);
    const input: VideoCompressPresetOptionsInput = {};
    const mut = input as Record<string, unknown>;
    if ('codec' in cell) mut.codec = translateEnum('VideoCodec', cell.codec as string);
    if ('targetSize' in cell) mut.targetSize = cell.targetSize as string | number;
    if ('crf' in cell) mut.crf = cell.crf as number;
    if ('preset' in cell) mut.preset = translateEnum('VideoPreset', cell.preset as string);
    if ('width' in cell) mut.width = cell.width as number;
    if ('height' in cell) mut.height = cell.height as number;
    if ('fit' in cell) mut.fit = translateEnum('VideoFit', cell.fit as string);
    if ('fps' in cell) mut.fps = cell.fps as number;
    if ('faststart' in cell) mut.faststart = cell.faststart as boolean;
    if ('audioCodec' in cell) mut.audioCodec = translateEnum('AudioCodec', cell.audioCodec as string);
    if ('audioBitrate' in cell) mut.audioBitrate = translateEnum('AudioBitrate', cell.audioBitrate as string);
    return new VideoCompressPresetOptions(input);
  }
}
