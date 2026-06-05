# @giveitsmaller/sdk

TypeScript / Node.js SDK for the [GISL](https://giveitsmaller.com) (Give It Smaller) file compression and processing API.

## Install

```bash
npm install @giveitsmaller/sdk
```

Node.js 18+ required.

## Quickstart

```ts
import { GislClient, uploadSource, OperationType } from '@giveitsmaller/sdk';

const client = new GislClient({
  baseUrl: 'https://api.giveitsmaller.com',
  apiKey: 'REPLACE_ME_API_KEY',
});

const upload = await client.uploadFile('./photo.jpg');

const workflow = await client.createWorkflow({
  jobs: [
    {
      id: 'compressed',
      source: uploadSource(upload.fileId),
      operations: [
        { type: OperationType.compress, options: { mode: 'lossy', quality: 80 } },
      ],
    },
  ],
});

await client.waitForWorkflow(workflow.workflowId);

const dls = await client.getWorkflowDownloads(workflow.workflowId);
console.log('Compressed:', dls.downloads[0].files[0].downloadUrl);
```

> **Reusing an upload id across clients?** An upload created by an
> authenticated caller is owned by that caller. If you persist a `fileId` and
> later reference it (via `fileInput.uploadId(id)`) from a client configured
> with a *different* `apiKey`/session, workflow-create returns
> `404 upload_not_found` — the server enforces ownership. Reference an upload id
> only under the same auth that created it; the upload-then-create flow above is
> consistent by construction. Anonymous-intake uploads are unaffected.

## Full documentation

Docs are published in the [giveitsmaller-sdks](https://github.com/AntonioCS/giveitsmaller-sdks) repository — they are **not** shipped in the npm tarball (only `dist/` is published).

- **Getting started & concepts** — [`docs/typescript/index.md`](https://github.com/AntonioCS/giveitsmaller-sdks/blob/main/docs/typescript/index.md)
- **Client reference** (all `GislClient` methods + operation option list) — [`docs/typescript/client.md`](https://github.com/AntonioCS/giveitsmaller-sdks/blob/main/docs/typescript/client.md)
- **Types & authoring primitives** (config, payloads, job factories) — [`docs/typescript/types.md`](https://github.com/AntonioCS/giveitsmaller-sdks/blob/main/docs/typescript/types.md)
- **SSE / live progress** — [`docs/typescript/sse.md`](https://github.com/AntonioCS/giveitsmaller-sdks/blob/main/docs/typescript/sse.md)
- **Webhooks** — [`docs/typescript/webhook.md`](https://github.com/AntonioCS/giveitsmaller-sdks/blob/main/docs/typescript/webhook.md)
- **Errors & retry guidance** — [`docs/typescript/errors.md`](https://github.com/AntonioCS/giveitsmaller-sdks/blob/main/docs/typescript/errors.md)
- **Troubleshooting** — [`docs/typescript/troubleshooting.md`](https://github.com/AntonioCS/giveitsmaller-sdks/blob/main/docs/typescript/troubleshooting.md)
- **Examples** — compress, thumbnail, convert, merge, archive — [`docs/typescript/examples/`](https://github.com/AntonioCS/giveitsmaller-sdks/tree/main/docs/typescript/examples)

## License

MIT — see the [LICENSE](https://github.com/AntonioCS/giveitsmaller-sdks/blob/main/LICENSE) file.
