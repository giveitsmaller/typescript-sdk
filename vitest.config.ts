import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],

    // ⚠️ SINGLE FORKED PROCESS, DELIBERATELY. This is a memory bound, not a
    // performance choice, and it is here in the CONFIG rather than in the make
    // target so that a bare `npx vitest run` is bounded too — the unbounded
    // invocation is the one a future session will reach for.
    //
    // 2026-05-28: the default worker pool OOM-killed this VM. Vitest workers
    // held ~5.3GB RSS between them, journald and the snapd watchdog timed out,
    // and the host froze for ~10 minutes. The VM is shared — rust-analyzer
    // (~4GB) plus several agent processes — so peak vitest memory is not this
    // repo's to spend freely.
    //
    // `singleFork` runs every test file in ONE child process instead of N.
    // Slower, and it cannot reproduce that failure. It is paired with a heap
    // cap on that child — see `execArgv` below.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,

        // The heap cap on the TEST WORKER, here for the same reason
        // `singleFork` is: a bare `npx vitest run` gets it too. Previously it
        // came only from `NODE_OPTIONS` in `scripts/local-suite.sh`, and CI set
        // nothing — which is how `s9lRKBym` happened: ten `spawn ENOMEM`
        // failures in one day, all esbuild's service in browser-bundle.test.ts.
        //
        // `spawn ENOMEM` is fork() refused because the PARENT is large. With
        // every test file in one child and no cap, V8 grows toward Node's
        // default ceiling instead of collecting, so the process being copied is
        // as big as it will ever get by the time that gate forks esbuild.
        //
        // ⚠️ TWO BOUNDS WITH DIFFERENT SCOPES, and this is not a single source
        // for the number. This one covers THE FORKED WORKER only.
        // `local-suite.sh` also exports NODE_OPTIONS, which covers the whole
        // container process tree INCLUDING the vitest/Vite main process — that
        // is the broader property the 2026-05-28 OOM needed, and it is the one
        // that keeps a leak in the main process from taking a shared VM.
        // execArgv wins over NODE_OPTIONS for this child, so lowering the
        // script's number alone would NOT change the worker.
        // ⇒ CI has no main-process bound. The 05-28 property therefore holds
        // locally and only half-holds in CI, where the runner is not shared.
        //
        // ⚠️ And this caps V8's OLD SPACE, not RSS: code space, external
        // ArrayBuffers and pages V8 has freed but not returned to the OS all
        // sit outside it. Largest controllable contributor, not the whole of
        // it — if ENOMEM recurs under this cap, see `s9lRKBym` before raising
        // the number.
        execArgv: ['--max-old-space-size=1536'],
      },
    },
  },
});
