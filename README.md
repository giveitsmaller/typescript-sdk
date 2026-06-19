# @giveitsmaller/sdk

TypeScript / Node.js SDK for the [GISL](https://giveitsmaller.com) (Give It Smaller) file compression and processing API.

## Install

```bash
npm install @giveitsmaller/sdk
```

Node.js 18+ required.

## Quickstart

The SDK is **file-first**: you start from a file (`.file(path)` for one,
`.files([paths])` for many) and call operations *on* it — upload, workflow
creation, and waiting all happen for you.

```ts
import { gisl, OptimizeFor } from '@giveitsmaller/sdk';

// baseUrl defaults to https://api.giveitsmaller.com; the key can also come
// from GISL_API_KEY or ~/.gisl/credentials.
const client = await gisl.create({ apiKey: 'sk_...' });

// One file:
const result = await client
  .file('./photo.jpg')
  .compress(OptimizeFor.Balanced)
  .run({ maxWait: '5m' });

console.log(result.url); // pre-signed download URL

// Many files (fan-out) — the same chain:
const many = await client
  .files(['./a.jpg', './b.png'])
  .compress(OptimizeFor.Balanced)
  .run();

for (const artifact of many.artifacts) console.log(artifact.url);
```

> **Operation-first / low-level also ships.** A lower-level
> `client.compress(path, { ... }).run()` form (and `thumbnail` / `convert`) is
> available, and the raw wire client — `client.createWorkflow({ jobs: [...] })`
> with `uploadSource` / `OperationType` for hand-built job DAGs — is the advanced
> escape hatch. File-first is the recommended direction the
> [examples](https://github.com/AntonioCS/giveitsmaller-sdks/tree/main/docs/typescript/examples)
> build on.

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

## Contributing: the committed `dist/`

Unlike most packages, `packages/typescript/dist/` is **committed**, not gitignored.
This is deliberate: consumers that install the SDK via the `file:` protocol (the
e2e canary, the frontend, the API repo, local dev) get whatever is on disk — npm
does **not** run `prepare`/`prepack` for `file:` deps, so a `dist/` that lagged
behind `src/` would silently ship stale exports.

When you change anything under `src/`, rebuild and commit `dist/`:

```bash
npm run build   # tsc → dist/
```

CI enforces this with a freshness guard that rebuilds `dist/` and fails the PR on
any `git diff` against the committed tree (mirroring the `git diff --exit-code
generated/` drift rule). `typescript` is pinned to an exact version so the rebuild
is reproducible. New hand-written SDK packages (PHP/Python) that grow a build step
should follow the same commit-`dist`-and-guard convention to avoid reintroducing
the `file:` gap.

## License

MIT — see the [LICENSE](https://github.com/AntonioCS/giveitsmaller-sdks/blob/main/LICENSE) file.
