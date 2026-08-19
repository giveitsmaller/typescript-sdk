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
    // `singleFork` runs every file in ONE child process instead of N. Slower,
    // and it cannot reproduce that failure. Pair it with a heap cap
    // (`NODE_OPTIONS=--max-old-space-size=…`, set by the make target) so an
    // unexpected leak DIES LOUDLY at its own ceiling rather than taking the
    // machine with it.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
