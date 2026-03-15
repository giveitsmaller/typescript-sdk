import { describe, it, expect } from 'vitest';
import { fileJob, sourceJob, inputsJob } from '../../src/types.js';

describe('Job factory functions', () => {
  it('fileJob creates a file-based job payload', () => {
    const job = fileJob('img-compress', 'file-abc-123', [
      { type: 'compress', options: { quality: 80 } },
    ]);
    expect(job).toEqual({
      ref: 'img-compress',
      file_id: 'file-abc-123',
      operations: [{ type: 'compress', options: { quality: 80 } }],
    });
  });

  it('sourceJob creates a source-based job payload', () => {
    const job = sourceJob(
      'thumbnail-job',
      { ref: 'img-compress', operation: 'compress' },
      [{ type: 'thumbnail' }],
    );
    expect(job).toEqual({
      ref: 'thumbnail-job',
      source: { ref: 'img-compress', operation: 'compress' },
      operations: [{ type: 'thumbnail' }],
    });
  });

  it('inputsJob creates a multi-input job payload', () => {
    const job = inputsJob(
      'merge-job',
      [
        { ref: 'clip-1' },
        { ref: 'clip-2', per_input_options: { transition: 'fade' } },
      ],
      [{ type: 'merge', options: { output_format: 'mp4' } }],
    );
    expect(job).toEqual({
      ref: 'merge-job',
      inputs: [
        { ref: 'clip-1' },
        { ref: 'clip-2', per_input_options: { transition: 'fade' } },
      ],
      operations: [{ type: 'merge', options: { output_format: 'mp4' } }],
    });
  });
});
