// CODE GENERATED — DO NOT EDIT.
// Source: compression_contracts operation-capabilities/operation-capabilities.json
// (compress.audio.bitrate.lossless_output) and schemas/operations/compress.yaml (mime_groups.audio.mimes).
// Regenerate with: scripts/generate.py.

/** Compress audio input MIMEs on which the contract refuses `bitrate` (lossless). */
export const COMPRESS_AUDIO_BITRATE_REFUSED_MIMES: ReadonlySet<string> = new Set(["audio/flac", "audio/wav"]);

/** Compress audio input MIMEs on which the contract accepts `bitrate` (lossy). */
export const COMPRESS_AUDIO_BITRATE_ACCEPTED_MIMES: ReadonlySet<string> = new Set(["audio/aac", "audio/mp4", "audio/mpeg", "audio/ogg"]);
