// T4a — AudioCompressPresetOptions leaf DTO.
//
// Field set per ticket VhIj4S7T: audio = 4 fields
//   (bitrate, channels, sampleRate, normalize).
// Trim is deliberately excluded — content selection lives on the per-call
// operation argument, not the preset cell.

import {
  AudioBitrate,
  AudioSampleRate,
  OptimizeFor,
} from '../../generated/sdk_spec/enums.js';
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';
import { translateEnum } from './_translate.js';

export interface AudioCompressPresetOptionsInput {
  readonly bitrate?: AudioBitrate;
  readonly channels?: number;
  readonly sampleRate?: AudioSampleRate;
  readonly normalize?: boolean;
}

export class AudioCompressPresetOptions {
  readonly bitrate?: AudioBitrate;
  readonly channels?: number;
  readonly sampleRate?: AudioSampleRate;
  readonly normalize?: boolean;

  private constructor(input: AudioCompressPresetOptionsInput) {
    if (input.bitrate !== undefined) this.bitrate = input.bitrate;
    if (input.channels !== undefined) this.channels = input.channels;
    if (input.sampleRate !== undefined) this.sampleRate = input.sampleRate;
    if (input.normalize !== undefined) this.normalize = input.normalize;
    Object.freeze(this);
  }

  static from(input: AudioCompressPresetOptionsInput): AudioCompressPresetOptions {
    return new AudioCompressPresetOptions(input);
  }

  static shippedDefaultsFor(level: OptimizeFor): AudioCompressPresetOptions {
    const cell = f3ShippedDefaultsFor('audio_compress', level);
    const input: AudioCompressPresetOptionsInput = {};
    const mut = input as Record<string, unknown>;
    // bitrate / sampleRate values in PRESETS are member-name strings like
    // "_96" / "_44100"; translateEnum resolves them to the numeric wire
    // value (`AudioBitrate._96 === 96`).
    if ('bitrate' in cell) mut.bitrate = translateEnum('AudioBitrate', cell.bitrate as string);
    if ('channels' in cell) mut.channels = cell.channels as number;
    if ('sampleRate' in cell) mut.sampleRate = translateEnum('AudioSampleRate', cell.sampleRate as string);
    if ('normalize' in cell) mut.normalize = cell.normalize as boolean;
    return new AudioCompressPresetOptions(input);
  }
}
