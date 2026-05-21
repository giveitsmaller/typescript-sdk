/**
 * Value-bearing guards for the v2.12.0 regen (UyQdloti + do8qKppo): the polled
 * status + downloads paths must surface the per-operation diagnostic fields the
 * SDK previously dropped.
 *
 * - UyQdloti: `error_code` / `error_message` on a polled failed `OperationResponse`
 *   (these existed only on the SSE `SseOperationFailedData` before the contracts
 *   parity-fill, so a polling consumer saw `status:'failed'` with no readable why).
 * - do8qKppo: `page_index` / `position` on `OperationDownload` (multi-page PDF
 *   fan-out — which output maps to which page; mutually exclusive).
 *
 * These assert the fields flow through the generated deserializers
 * (WorkflowStatusResponse → jobs → operations, WorkflowDownloadResponse →
 * downloads → files) with no SDK hand-coding, so a future regen that drops them
 * fails here rather than silently in a consumer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GislClient } from '../../src/client.js';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('operation diagnostic fields (v2.12.0 regen)', () => {
  let client: GislClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new GislClient({ baseUrl: 'https://api.example.com', apiKey: 'k' });
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getWorkflowStatus surfaces error_code/error_message on a failed op (UyQdloti)', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          workflow_id: 'wf-1',
          status: 'failed',
          created_at: '2026-05-21T10:00:00Z',
          updated_at: '2026-05-21T10:01:00Z',
          jobs: [
            {
              ref: 'job_a',
              job_id: 'j-1',
              status: 'failed',
              depends_on: [],
              operations: [
                {
                  id: 'op-1',
                  type: 'compress',
                  status: 'failed',
                  error_code: 'output_too_large',
                  error_message:
                    'output_too_large: Output (12156489 bytes) is not smaller than input (6187609 bytes)',
                },
              ],
            },
          ],
        },
      }),
    );

    const result = await client.getWorkflowStatus('wf-1');
    const op = result.jobs[0].operations[0];
    expect(op.status).toBe('failed');
    expect(op.errorCode).toBe('output_too_large');
    expect(op.errorMessage).toContain('not smaller than input');
  });

  it('leaves errorCode/errorMessage undefined on a non-failed op', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          workflow_id: 'wf-2',
          status: 'completed',
          created_at: '2026-05-21T10:00:00Z',
          updated_at: '2026-05-21T10:01:00Z',
          jobs: [
            {
              ref: 'job_a',
              job_id: 'j-1',
              status: 'completed',
              depends_on: [],
              operations: [{ id: 'op-1', type: 'compress', status: 'completed' }],
            },
          ],
        },
      }),
    );

    const op = (await client.getWorkflowStatus('wf-2')).jobs[0].operations[0];
    expect(op.errorCode).toBeUndefined();
    expect(op.errorMessage).toBeUndefined();
  });

  it('getWorkflowDownloads surfaces page_index/position on outputs (do8qKppo)', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          downloads: [
            {
              ref: 'job_pdf',
              job_id: 'j-1',
              files: [
                {
                  operation: 'convert',
                  operation_id: 'op-1',
                  filename: 'page-1.png',
                  size_bytes: 1234,
                  download_url: 'https://dl.example.com/page-1.png',
                  page_index: 1,
                },
                {
                  operation: 'merge',
                  operation_id: 'op-2',
                  filename: 'clip.mp4',
                  size_bytes: 5678,
                  download_url: 'https://dl.example.com/clip.mp4',
                  // position is 0-based — use 0 to lock the zero boundary: the
                  // FromJSON `== null ? undefined` guard preserves 0, but a
                  // naive `|| undefined` regression would wrongly drop it.
                  position: 0,
                },
                {
                  operation: 'compress',
                  operation_id: 'op-3',
                  filename: 'single.jpg',
                  size_bytes: 90,
                  download_url: 'https://dl.example.com/single.jpg',
                },
              ],
            },
          ],
        },
      }),
    );

    const files = (await client.getWorkflowDownloads('wf-1')).downloads[0].files;
    // page_index output
    expect(files[0].pageIndex).toBe(1);
    expect(files[0].position).toBeUndefined();
    // position output (mutually exclusive with page_index) — 0 is a valid
    // 0-based value and must survive the FromJSON null-guard, not be dropped.
    expect(files[1].position).toBe(0);
    expect(files[1].pageIndex).toBeUndefined();
    // unindexed single output — both absent
    expect(files[2].pageIndex).toBeUndefined();
    expect(files[2].position).toBeUndefined();
  });
});
