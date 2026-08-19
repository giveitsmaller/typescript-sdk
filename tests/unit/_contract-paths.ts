import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
// tests/unit/_contract-paths.ts -> ../../../.. = sdks repo root
// (up out of unit/, tests/, typescript/, packages/)
export const SDKS_REPO_ROOT = resolve(TEST_DIR, '../../../..');
export const CLIENT_SRC_PATH = resolve(SDKS_REPO_ROOT, 'packages/typescript/src/client.ts');
export const TYPES_SRC_PATH = resolve(SDKS_REPO_ROOT, 'packages/typescript/src/types.ts');

/**
 * CI (`actions/checkout` at the ref computed from `.contracts-version`) and
 * `scripts/local-suite.sh` (a detached worktree at the same pin, bind-mounted
 * read-only) both place the contracts repo HERE. In both cases the content is
 * already the pinned revision, so reading the file directly is correct.
 *
 * ⚠️ Must be tested as a FILE, not merely as an existing path. `docker run -v
 * …:/app/compression_contracts` creates this directory on the host as root when
 * it is absent, so an EMPTY `compression_contracts/` is a routine leftover of a
 * local-suite run. A bare `existsSync` on the directory would match it.
 */
const CI_LAYOUT_SPEC = resolve(SDKS_REPO_ROOT, 'compression_contracts/openapi/api.yaml');

/** The developer's sibling clone — a LIVE working directory, not a fixed input. */
const SIBLING_REPO = resolve(SDKS_REPO_ROOT, '../compression_contracts');
const SIBLING_SPEC = resolve(SIBLING_REPO, 'openapi/api.yaml');

const SPEC_PATH_IN_REPO = 'openapi/api.yaml';

function pinnedContractsVersion(): string | null {
  try {
    const pin = readFileSync(resolve(SDKS_REPO_ROOT, '.contracts-version'), 'utf8').trim();
    return pin === '' ? null : pin;
  } catch {
    return null;
  }
}

function git(args: readonly string[]): string | null {
  try {
    return execFileSync('git', ['-C', SIBLING_REPO, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

export interface ContractsSpec {
  /** The spec source. */
  readonly yaml: string;
  /** Where it came from, in a form that identifies a COMMIT rather than a path. */
  readonly provenance: string;
}

/**
 * Read `openapi/api.yaml` from the contracts repo — **from the committed tree
 * wherever possible**.
 *
 * ⚠️ A SIBLING CHECKOUT IS NOT A FIXED INPUT. It is another session's live
 * working directory and it changes without telling you. Measured 2026-08-19
 * while writing this: that sibling moved from `fix/importorskip-is-dead-code-in-ci`
 * to `fix/tracked-vs-untracked-is-publication-vs-scratch` BETWEEN TWO COMMANDS
 * a minute apart, and its `api.yaml` was 20 lines ahead of our pin on both. A
 * drift number taken off it is a number about a state that may have existed for
 * ninety seconds.
 *
 * Printing the branch beside the number would make a wrong read VISIBLE.
 * Reading the committed tree makes it IMPOSSIBLE, and settles tracked-vs-
 * untracked for free: an uncommitted edit is not in the pinned revision at all.
 * So the working tree is the last resort, taken only with a labelled warning —
 * never silently.
 */
export function readContractsRepoSpec(): ContractsSpec {
  const pin = pinnedContractsVersion();

  // 1. Content placed by CI's checkout or by local-suite.sh's pinned mount.
  //
  //    ⚠️ ITS REVISION IS ASSERTED BY THE HARNESS, NOT ESTABLISHED HERE, AND
  //    THE PROVENANCE MUST SAY WHICH (codex 24c20bdebf16). A bare path claiming
  //    "already at the pinned revision" would be a docstring describing what the
  //    code is supposed to do rather than what it checks — and a stale nested
  //    checkout would inherit that claim silently.
  //
  //    So: resolve the commit if the directory is a usable git checkout (CI's
  //    `actions/checkout` is), and otherwise name the pin as CLAIMED. The local
  //    mount is a detached worktree whose `.git` is a FILE pointing at a host
  //    path that does not exist inside the container, so git legitimately fails
  //    there — that is an unverifiable source, not a broken one.
  if (existsSync(CI_LAYOUT_SPEC) && statSync(CI_LAYOUT_SPEC).isFile()) {
    const dir = resolve(SDKS_REPO_ROOT, 'compression_contracts');
    let sha: string | null = null;
    try {
      sha = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      sha = null;
    }
    return {
      yaml: readFileSync(CI_LAYOUT_SPEC, 'utf8'),
      provenance:
        sha !== null
          ? `${CI_LAYOUT_SPEC} @ ${sha} (checkout, revision verified; pin claims ${pin ?? 'none'})`
          : `${CI_LAYOUT_SPEC} (mount claiming pin ${pin ?? 'none'} — revision NOT verifiable here)`,
    };
  }

  // 2. The committed tree at OUR pin. Not the sibling's origin/main: the pin is
  //    what CI checks out and what the drift tests are meant to be measured
  //    against, so main would be a different — and equally arbitrary — tree.
  if (pin !== null) {
    const yaml = git(['show', `${pin}:${SPEC_PATH_IN_REPO}`]);
    if (yaml !== null) {
      const sha = git(['rev-parse', '--short', `${pin}^{commit}`])?.trim() ?? 'unknown';
      return { yaml, provenance: `${pin} (${sha}) via \`git show\` — committed, reproducible` };
    }
  }

  // 3. Last resort: the live working tree, NAMED. Not silent, because the whole
  //    failure mode is that nobody could tell which tree a number came from.
  if (existsSync(SIBLING_SPEC) && statSync(SIBLING_SPEC).isFile()) {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() ?? 'unknown';
    const head = git(['rev-parse', '--short', 'HEAD'])?.trim() ?? 'unknown';
    const dirty = git(['status', '--porcelain', '--', SPEC_PATH_IN_REPO])?.trim();
    const state = dirty ? 'UNCOMMITTED EDITS' : 'clean';
    // eslint-disable-next-line no-console
    console.warn(
      `⚠️  contracts spec read from the LIVE WORKING TREE, not a committed revision.\n` +
        `    ${SIBLING_SPEC}\n` +
        `    branch ${branch} @ ${head}, ${SPEC_PATH_IN_REPO} ${state}\n` +
        `    ${pin === null ? '.contracts-version is unreadable' : `\`git show ${pin}:${SPEC_PATH_IN_REPO}\` failed — fetch the tag`}.\n` +
        `    Any drift count below describes THAT tree and is not reproducible.`,
    );
    return {
      yaml: readFileSync(SIBLING_SPEC, 'utf8'),
      provenance: `WORKING TREE ${branch} @ ${head} (${state}) — NOT reproducible`,
    };
  }

  throw new Error(
    `Could not read compression_contracts ${SPEC_PATH_IN_REPO}. Tried:\n` +
      `  - ${CI_LAYOUT_SPEC} (CI layout / local-suite mount)\n` +
      `  - \`git -C ${SIBLING_REPO} show ${pin ?? '<no pin>'}:${SPEC_PATH_IN_REPO}\`\n` +
      `  - ${SIBLING_SPEC} (working tree)\n\n` +
      `Ensure compression_contracts is a sibling of giveitsmaller-sdks and has the ` +
      `revision named in .contracts-version fetched.`,
  );
}

export const GENERATED_SPEC_PATH = resolve(
  SDKS_REPO_ROOT,
  'generated/typescript/openapi/api.yaml',
);
