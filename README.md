# @giveitsmaller/sdk

TypeScript / Node.js SDK for the [GISL](https://giveitsmaller.com) (Give It Smaller) file compression and processing API.

> **Read-only mirror.** This repository is automatically published from Give It Smaller's private monorepo on each release. Do **not** open issues or pull requests here — they are not monitored. Licensed under [Apache-2.0](./LICENSE).

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
> escape hatch. File-first is the recommended direction to build on.

> **Reusing an upload id across clients?** An upload created by an
> authenticated caller is owned by that caller. If you persist a `fileId` and
> later reference it (via `fileInput.uploadId(id)`) from a client configured
> with a *different* `apiKey`/session, workflow-create returns
> `404 upload_not_found` — the server enforces ownership. Reference an upload id
> only under the same auth that created it; the upload-then-create flow above is
> consistent by construction. Anonymous-intake uploads are unaffected.

## Known limitation — browser SSE is restricted to one origin

**Applies to the browser build only** (`@giveitsmaller/sdk/browser`), and **only to live progress
streaming** — `streamEvents()`, and the `run({ useSSE: true })` default that uses it.

Live progress is served from a **separate host** to the rest of the API, and that host allows
**exactly one browser origin**: the Give It Smaller web app. So from a browser on any other origin:

| what you are doing | works? |
|---|---|
| Uploads, workflow create, status, downloads | **Yes** — these stay on the main API host, which allows a **list** of origins (per environment) |
| `streamEvents()` / SSE progress | **No** — blocked at the CORS preflight |

**Affected consumers:** third-party sites embedding the SDK, embedded/iframe use, and **local
development against staging** — which is the one most likely to bite first, because it looks like a
bug in your code.

⚠️ **Local dev against staging is the sharp edge, and the reason is worth stating:** the two hosts
have *different* CORS policies today. The main API host allows a **list** of origins — and the
**staging** list includes the usual localhost dev ports — so a browser on `localhost` works against
staging today. The stream host is configured with exactly **one** origin. So everything keeps
working right up until live progress, and then fails with a CORS error — which reads like a mistake
in your own application rather than a deployment setting.

**Production allows only the production web app on both hosts**, and always has.

**Workaround:** pass `useSSE: false` to `run()`. The SDK falls back to polling, which goes to the
main API host and is unaffected. Everything else about the call is identical.

**Why it is not a one-line config change — and why it is NOT impossible.** An earlier version of
this section said multi-origin support could not be done on this host. **That was wrong, and it is
corrected here.** What is true: `Access-Control-Allow-Origin` accepts exactly one origin (a
comma-separated list is not valid), and because the stream can be cookie-credentialed, the CORS
specification also forbids answering `*` alongside `Access-Control-Allow-Credentials: true`. What
does **not** follow is that more origins are unreachable. The server can validate the request's
`Origin` and echo it back, which is how every multi-origin credentialed endpoint works. That is a
**change somebody has to build and get right**, not a platform prohibition — so treat this as
unshipped work with its own correctness risk, not as a closed door.

**On authentication:** prefer an API key (`bearerAuth`) or the anonymous capability token on the
stream host. Cookie/session auth is accepted by the endpoint but a *credentialed cross-origin*
request additionally needs the browser to opt in and the server to answer with matching credential
headers — cookie domain scope alone is not sufficient, and this path is not verified.

**Node consumers are unaffected** — CORS is a browser mechanism. The PHP SDK is unaffected for the
same reason.

> ⚠️ This limitation is invisible to automated testing: our own app's origin is allowed, so every
> test and canary we run passes while a consumer on another origin fails. It is written here because
> nothing else would tell you.

## Pointing the event stream at its own host

Live progress is served from a **second host**, separate from `baseUrl`. The SDK reads that host
from the contract's declaration — it **never derives** `stream.*` from `api.*`.

```ts
// Resolved from the environment's declared stream host.
const client = await gisl.create({ apiKey, environment: 'staging' });

// Or point it explicitly. This moves the STREAM only — uploads, workflow-create
// and downloads still go to baseUrl.
const client = await gisl.create({
  apiKey,
  environment: 'staging',
  streamBaseUrl: 'https://stream.example.com',
});
```

`GISL_STREAM_BASE_URL` does the same thing from the environment. Precedence matches `baseUrl`:
explicit argument, then `environment`, then the env var.

⚠️ **If nothing declares a stream host, the SDK does not fall back to `baseUrl`.** `streamEvents()`
throws `GislStreamHostNotDeclaredError` (a `GislConfigError`), and `run()` silently uses polling
instead, which is a working transport. **This is deliberate.** Guessing the stream host from the API
host is a convention, and the last time a client did that it streamed into a gateway that cannot
stream, invisibly — a silent fallback looks exactly like a working one.

Both `prod` and `staging` resolve to their contract-declared hosts (production landed with
contracts `v2.195.0`), and an **unconfigured** client resolves production for the stream just as it
already did for the API. What still fails closed is a **custom** host: pass your own `baseUrl` (or
set `GISL_BASE_URL`) with no `streamBaseUrl` and `streamEvents()` raises rather than guessing that
your proxy's stream lives at production.

## Documentation

Full documentation — getting started and concepts, the `GislClient` reference and operation
options, authoring primitives, SSE/live progress, webhooks, error/retry guidance, troubleshooting,
and per-operation examples — lives at [giveitsmaller.com](https://giveitsmaller.com).

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

Apache-2.0 — see the [LICENSE](./LICENSE) file.
