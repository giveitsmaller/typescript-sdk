import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ts from 'typescript';

/**
 * BQXpFV2R — the public export surface is COMPUTED from source and compared to a
 * committed snapshot, so "which symbols are public" is never a human's memory.
 *
 * ⚠️ THIS EXISTS BECAUSE THE HAND-WRITTEN LIST IN `src/_audit.ts` WAS WRONG BY
 * OMISSION. That file makes 117 `accept<T>()` assertions; 249 of the 381 exports
 * appear nowhere in it, and 95 of those are declared locally in `src/` —
 * including the entire `Gisl*Error` tree and `GislClient` itself. Adding names to
 * a hand list fixes today's gap and leaves the mechanism that produced it. This
 * test is the mechanism's replacement: `_audit.ts` keeps only the SIGNATURE
 * assertions a name-and-kind snapshot cannot express.
 *
 * ⚠️ THE EXPORT GRAMMAR IS DERIVED FROM THE COMPILER, NOT RE-IMPLEMENTED BY HAND.
 * See the long note on `collectExports` below for why (hub decision 238) and for
 * the two constraints — no `node_modules` resolution, bounded memory — that shape
 * how the Program is built. An earlier version of this file enumerated exports
 * from the AST itself; that note records what happened to it and is the thing to
 * read before changing any of this.
 */

const PKG_ROOT = resolve(__dirname, '..');
const SRC_DIR = join(PKG_ROOT, 'src');
const SNAPSHOT_DIR = join(__dirname, 'api-surface');

// ---------------------------------------------------------------------------
// Regeneration mode. Run via `npm run api:update`. REFUSES TO RUN IN CI — the
// snapshot IS the gate, so a path that rewrites the reference file and returns
// green must never be reachable where it runs unattended. Mirrors
// `tests/parity/parity.test.ts:35-40`, which refuses the same combination for
// the same reason: a committed artefact is updated deliberately on a human's
// machine, never from a PR checks run, because accepting the diff is the
// review.
// ---------------------------------------------------------------------------
const UPDATE_MODE = process.env['UPDATE_API_SNAPSHOT'] === '1';
if (UPDATE_MODE && process.env['CI'] === 'true') {
  throw new Error(
    'UPDATE_API_SNAPSHOT=1 is a local-only regeneration path. Unset CI or unset UPDATE_API_SNAPSHOT.',
  );
}

/** `value`, `type`, or both — a class or enum is exported into both namespaces. */
type ExportKind = 'value' | 'type' | 'value+type';

interface ExportRow {
  readonly name: string;
  readonly kind: ExportKind;
}

/**
 * `package.json` `exports` points at BUILT output (`./dist/index.js`), never at
 * source. Translate: strip the `./dist/` prefix and the `.js` / `.d.ts` suffix,
 * then resolve under `src/` as `.ts`.
 *
 * ⚠️ Entry points are DERIVED, never hard-coded — a future subpath entry would
 * otherwise become public with no snapshot coverage and nothing would go red.
 * An unmappable leaf THROWS rather than being skipped.
 */
function entryModulesFromPackageJson(): Map<string, string> {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
    exports?: Record<string, unknown>;
  };
  const exportsMap = pkg.exports;
  if (exportsMap === undefined) throw new Error('package.json has no `exports` map');

  const leaves: string[] = [];
  const collect = (node: unknown): void => {
    if (typeof node === 'string') {
      leaves.push(node);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const v of Object.values(node as Record<string, unknown>)) collect(v);
    }
  };
  collect(exportsMap);
  if (leaves.length === 0) throw new Error('package.json `exports` yielded no string leaves');

  // Several leaves resolve to the same module (`.` has browser/types/default
  // conditions, and `./browser` targets the browser module too). Deduplicate by
  // resolved source path, keyed by a stable label for the snapshot filename.
  const modules = new Map<string, string>();
  for (const leaf of leaves) {
    const stripped = leaf.replace(/^\.\/dist\//, '').replace(/\.d\.ts$|\.js$/, '');
    const srcPath = join(SRC_DIR, `${stripped}.ts`);
    if (!existsSync(srcPath)) {
      throw new Error(
        `exports leaf ${leaf} maps to ${srcPath}, which does not exist. ` +
          'Entry-point discovery must fail loudly rather than skip an unmapped leaf.',
      );
    }
    modules.set(stripped, srcPath);
  }
  return modules;
}


/**
 * 🔴 THE EXPORT GRAMMAR IS THE COMPILER'S PROBLEM, NOT OURS (hub decision 238).
 *
 * This used to enumerate exports by hand from the AST. Nine cross-model review
 * rounds found roughly 36 substantive findings against that walker with ZERO
 * repeats and no convergence — each pass sampled a different part of TypeScript's
 * export grammar and found another form handled wrongly or not at all: relative
 * re-export kind chains, `export type *`, star-vs-star ambiguity, `export import
 * Alias = NS`, default exports, destructuring. That is not a review process
 * failing; it is the signature of re-implementing a grammar the compiler already
 * owns. So we ask the compiler: `checker.getExportsOfModule()` on the entry's
 * module symbol, and kind from the resolved symbol's flags.
 *
 * ⚠️ THE PROGRAM RESOLVES RELATIVE SPECIFIERS ONLY. `resolveModuleNameLiterals`
 * returns `undefined` for every bare one, so `node_modules` is NEVER READ. This is
 * not tidiness — `packages/typescript/node_modules` is root-owned and holds
 * contracts 0.9.0 while the manifest requires ^0.70.0, and CI swaps it for a
 * `file:` path. A checker allowed to resolve bare specifiers would produce a
 * snapshot that PASSES WHERE IT WAS GENERATED AND FAILS WHERE IT IS CHECKED. The
 * limit that used to be a property of the hand-written walk is now an explicit
 * property of the compiler host, which is a better place for it.
 *
 * ⚠️ AND THAT IS WHY KIND IS A HYBRID, deliberately. For a name whose alias chain
 * stays inside the relative graph, the checker's symbol flags are authoritative.
 * For one that dead-ends at a bare specifier the checker knows nothing — but the
 * SYNTAX still does: `export type { X } from '@giveitsmaller/contracts/openapi'`
 * says type-only on its face. Falling back to the `type` keyword there is strictly
 * more information than an unresolved alias symbol carries, not less.
 *
 * ⚠️ THE COMPILER DOES NOT OWN ALL OF IT, AND SAYING SO IS THE POINT. Measured on
 * this TypeScript version, `getExportsOfModule` handles destructuring, default
 * exports and `export import Alias = NS` correctly, but TWO forms it does not:
 *   · `export type * from './x.js'` — returns the target's class symbol with full
 *     value+type flags and emits NO diagnostic. Nothing distinguishes it.
 *   · an ambiguous star-vs-star name — still returns the FIRST one, so absence
 *     cannot be asserted; the checker reports it as diagnostic TS2308 instead.
 * Both are REFUSED rather than hand-modelled: the ambiguity refusal reads TS2308,
 * and the type-star refusal is four lines of syntax. Re-deriving star semantics by
 * hand is precisely what decision 238 removed, so a partial compiler answer is
 * dealt with by declining the input, not by rebuilding the rule beside it.
 *
 * ⚠️ MEASURED, because the header above claims a Program is too expensive: with
 * `noLib` and no dependency typings this Program costs +61.4MB heapUsed / +128.4MB
 * RSS, 228MB RSS total — against the 1536MB cap `vitest.config.ts` puts on the
 * single forked worker. The ~+262MB figure in the original note was for a Program
 * that loaded lib and node_modules typings; this one loads neither.
 *
 * PROOF THE SWAP IS FAITHFUL: this derivation reproduces the snapshot the
 * hand-written walker produced EXACTLY — 381 names root / 379 browser, zero added,
 * zero removed, zero kind mismatches. Two independent mechanisms agreeing on all
 * 381 rows is the reason the committed files below do not move in this change.
 */

/** Type-side flags. A class or enum carries both these and `Value`. */
const TYPE_FLAGS =
  ts.SymbolFlags.Type |
  ts.SymbolFlags.Interface |
  ts.SymbolFlags.TypeAlias |
  ts.SymbolFlags.Class |
  ts.SymbolFlags.Enum |
  ts.SymbolFlags.TypeParameter;

const COMPILER_OPTIONS: ts.CompilerOptions = {
  noLib: true,
  target: ts.ScriptTarget.Latest,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};

/**
 * Resolve a RELATIVE specifier. Specifiers are emitted paths (`./x.js`); the file
 * is `./x.ts` — or `./x.d.ts`, which is the case that was missing.
 *
 * ⚠️ THE STRIPPED BASE MATTERS (codex 079096c07220). Appending `.d.ts` to the raw
 * specifier tests `x.js.d.ts`, which is not a thing. A relative `export * from
 * './types.js'` backed by a real `types.d.ts` therefore resolved to nothing, and
 * the resulting TS2307 was not read — so the whole module's public types dropped
 * out of the snapshot in silence.
 */
function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const stripped = base.replace(/\.js$/, '');
  for (const candidate of [`${stripped}.ts`, `${stripped}.d.ts`, `${base}.ts`, `${base}.d.ts`]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const isRelative = (specifier: string): boolean => specifier.startsWith('.');

function createRelativeOnlyProgram(entryFiles: readonly string[]): ts.Program {
  const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
  // 🔴 THE WHOLE POINT: bare specifiers resolve to nothing, so the snapshot cannot
  // depend on what happens to be installed. Do not "fix" this into a real resolver.
  host.resolveModuleNameLiterals = (literals, containingFile): ts.ResolvedModuleWithFailedLookupLocations[] =>
    literals.map((literal) => {
      const specifier = literal.text;
      if (!isRelative(specifier)) return { resolvedModule: undefined };
      const resolvedFileName = resolveRelative(containingFile, specifier);
      if (resolvedFileName === undefined) return { resolvedModule: undefined };
      return {
        resolvedModule: {
          resolvedFileName,
          extension: resolvedFileName.endsWith('.d.ts')
            ? ts.Extension.Dts
            : ts.Extension.Ts,
        },
      };
    });
  return ts.createProgram([...entryFiles], COMPILER_OPTIONS, host);
}

/**
 * Was this export's alias chain resolvable inside the relative graph?
 * `getAliasedSymbol` on an unresolvable alias yields a symbol with no declarations
 * (or throws), which is how a bare-specifier re-export announces itself.
 */
function resolveAlias(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
): { symbol: ts.Symbol; resolved: boolean } {
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return { symbol, resolved: true };
  try {
    const aliased = checker.getAliasedSymbol(symbol);
    const stillAlias = (aliased.flags & ts.SymbolFlags.Alias) !== 0;
    const hasDeclaration = (aliased.declarations?.length ?? 0) > 0;
    if (stillAlias || !hasDeclaration) return { symbol, resolved: false };
    return { symbol: aliased, resolved: true };
  } catch {
    return { symbol, resolved: false };
  }
}

/** The `type` keyword on an `export { … }` specifier or its statement, if present. */
function syntacticallyTypeOnly(symbol: ts.Symbol): boolean {
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isExportSpecifier(declaration)) {
      if (declaration.isTypeOnly) return true;
      const exportDeclaration = declaration.parent.parent;
      if (ts.isExportDeclaration(exportDeclaration) && exportDeclaration.isTypeOnly) return true;
      continue;
    }
    // ⚠️ `export type * as Types from './m.js'` binds its name through a
    // NamespaceExport, not an ExportSpecifier — ignoring that declaration kind here
    // recorded the namespace as `value` (codex 0036cfc10d6b). `validateModuleGraph`
    // refuses this form outright, so this branch is belt-and-braces: if the refusal
    // is ever relaxed into modelling the form, the kind is already correct.
    if (ts.isNamespaceExport(declaration)) {
      if (ts.isExportDeclaration(declaration.parent) && declaration.parent.isTypeOnly) return true;
    }
  }
  return false;
}

/**
 * Every name the package exposes from `entryFile`, with its namespace kind.
 *
 * A bare-specifier STAR export still THROWS: the checker cannot enumerate what it
 * was not allowed to resolve, so it would return a SHORTER list with no error —
 * the clean-but-wrong snapshot this gate exists to prevent. Zero exist today.
 */
/**
 * Refuse every export form the checker cannot report, ACROSS THE WHOLE MODULE
 * GRAPH — not just the entry file.
 *
 * 🔴 THIS SCOPE IS THE POINT (codex 2bc4c94a2d1d). These checks originally read
 * `entry.statements` and `getSemanticDiagnostics(entry)` only, which left the hole
 * almost exactly where the surface actually lives: `index.ts` and
 * `index.browser.ts` both re-export through `index.core.ts`, so nearly every
 * public name arrives through a NESTED barrel. A bare star, a type-star or an
 * ambiguous star one hop in was accepted in silence.
 *
 * Iterating `program.getSourceFiles()` is safe and cheap precisely BECAUSE of the
 * relative-only compiler host: the Program contains the relative graph and
 * nothing else — no lib, no `node_modules` — so "every file in the program" and
 * "every file reachable from the entry" are the same set. No traversal of our own.
 */
function validateModuleGraph(program: ts.Program): void {
  const AMBIGUOUS_STAR_EXPORT = 2308;

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile && sourceFile.fileName.includes('node_modules')) continue;

    for (const statement of sourceFile.statements) {
      if (!ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;

      // ⚠️ A NAMESPACE CLAUSE IS STILL A STAR EXPORT (codex 0036cfc10d6b).
      // `export type * as Types from './m.js'` has a `NamespaceExport` clause, so a
      // check keyed on `exportClause === undefined` skips it — and the module symbol
      // then records as `value`. Downgrading an existing `export * as Types` to the
      // type-only form would remove the runtime export with no snapshot drift.
      const isStar =
        statement.exportClause === undefined || ts.isNamespaceExport(statement.exportClause);
      if (!isStar) continue;

      // ⚠️ `export type *` — MEASURED: the checker gives NO signal for this.
      // `getExportsOfModule` returns the target's class symbol with full value+type
      // flags and emits no diagnostic, so a re-exported class would be recorded
      // `value+type` despite the type-only re-export having no value surface
      // (codex 938c78772a0e). Rather than re-implement star semantics by hand — the
      // exact thing decision 238 removed — refuse the form. Zero exist today.
      if (statement.isTypeOnly) {
        throw new Error(
          `type-only star export '${specifier.text}' in ${sourceFile.fileName}. ` +
            'getExportsOfModule does not mark these names type-only, so they would be ' +
            'recorded as value-bearing. Re-export the names explicitly with ' +
            '`export type { … }`, which the checker does model.',
        );
      }

      // A bare `export * as NS from 'pkg'` binds one local name the checker can see,
      // so only an unaliased bare star actually loses names.
      if (!isRelative(specifier.text) && statement.exportClause === undefined) {
        throw new Error(
          `bare-specifier star export '${specifier.text}' in ${sourceFile.fileName}. The ` +
            'checker is not allowed to resolve into node_modules, so these names would be ' +
            'missing from the snapshot with no error. Fail loud rather than under-report.',
        );
      }
    }

    // 🔴 AMBIGUOUS STAR EXPORTS, REPORTED BY THE COMPILER ITSELF (TS2308). A name
    // star-exported from two different modules is NOT re-exported under ES
    // semantics, but `getExportsOfModule` still returns the FIRST one — so the
    // snapshot would keep a symbol the package does not expose, hiding a breaking
    // removal (codex cde8bfdd398f). We do not re-derive the ambiguity rule; we read
    // the diagnostic the checker already produces. Filtered to that one code on
    // purpose: `noLib` makes the general diagnostic set noisy and irrelevant here.
    const ambiguous = program
      .getSemanticDiagnostics(sourceFile)
      .filter((d) => d.code === AMBIGUOUS_STAR_EXPORT);
    if (ambiguous.length > 0) {
      throw new Error(
        `ambiguous star export in ${sourceFile.fileName}: ` +
          ambiguous.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; '),
      );
    }
  }
}

function collectExports(entryFile: string, program?: ts.Program): Map<string, ExportKind> {
  const built = program ?? createRelativeOnlyProgram([entryFile]);
  const sourceFile = built.getSourceFile(entryFile);
  if (sourceFile === undefined) throw new Error(`entry ${entryFile} is not in the program`);

  validateModuleGraph(built);

  const checker = built.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol === undefined) {
    throw new Error(`no module symbol for ${entryFile} — it may export nothing at all`);
  }

  const rows = new Map<string, ExportKind>();
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const { symbol, resolved } = resolveAlias(checker, exported);
    if (!resolved) {
      // Dead-ends at a bare specifier. The `type` keyword is all the information
      // there is, and it is more than the unresolved symbol carries.
      rows.set(exported.name, syntacticallyTypeOnly(exported) ? 'type' : 'value');
      continue;
    }
    const isValue = (symbol.flags & ts.SymbolFlags.Value) !== 0;
    const isType = (symbol.flags & TYPE_FLAGS) !== 0;
    if (syntacticallyTypeOnly(exported)) {
      rows.set(exported.name, 'type');
      continue;
    }
    if (!isValue && !isType) {
      throw new Error(
        `'${exported.name}' in ${entryFile} resolved to a symbol in neither the value nor ` +
          'the type namespace. Recording a guess would defeat the gate.',
      );
    }
    rows.set(exported.name, isValue && isType ? 'value+type' : isValue ? 'value' : 'type');
  }
  return rows;
}


function serialize(rows: Map<string, ExportKind>): string {
  const lines: ExportRow[] = [...rows.entries()]
    .map(([name, kind]) => ({ name, kind }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return `${lines.map((r) => `${r.name}\t${r.kind}`).join('\n')}\n`;
}

function describeDrift(committed: string, actual: string): string {
  const parse_ = (text: string): Map<string, string> =>
    new Map(
      text
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => {
          const [name, kind] = l.split('\t');
          return [name as string, kind as string];
        }),
    );
  const before = parse_(committed);
  const after = parse_(actual);
  const added = [...after.keys()].filter((n) => !before.has(n));
  const removed = [...before.keys()].filter((n) => !after.has(n));
  const changed = [...after.entries()]
    .filter(([n, k]) => before.has(n) && before.get(n) !== k)
    .map(([n, k]) => `${n}: ${before.get(n)} -> ${k}`);
  return [
    added.length > 0 ? `ADDED: ${added.join(', ')}` : '',
    removed.length > 0 ? `REMOVED: ${removed.join(', ')}` : '',
    changed.length > 0 ? `KIND CHANGED: ${changed.join(', ')}` : '',
  ]
    .filter((s) => s.length > 0)
    .join('\n');
}

describe('public export surface — committed snapshot', () => {
  const entries = entryModulesFromPackageJson();

  it('discovers every entry point from package.json exports', () => {
    expect(entries.size).toBeGreaterThan(0);
    for (const path of entries.values()) expect(existsSync(path)).toBe(true);
  });

  for (const [label, entryFile] of entries) {
    it(`${label} matches its committed snapshot`, () => {
      const actual = serialize(collectExports(entryFile));
      const snapshotPath = join(SNAPSHOT_DIR, `${label.replace(/\//g, '__')}.txt`);

      if (UPDATE_MODE) {
        writeFileSync(snapshotPath, actual, 'utf8');
        return;
      }

      expect(
        existsSync(snapshotPath),
        `missing snapshot ${snapshotPath}. Regenerate with UPDATE_API_SNAPSHOT=1.`,
      ).toBe(true);
      const committed = readFileSync(snapshotPath, 'utf8');
      // ⚠️ Accepting a change is a DELIBERATE snapshot update in the PR, reviewed —
      // not a rubber stamp. The drift report names what moved so a reviewer can judge it.
      expect(actual, `public export surface changed:\n${describeDrift(committed, actual)}`).toBe(
        committed,
      );
    });
  }

  it('the browser entry is a strict subset of the root entry', () => {
    // 🔴 ASSERTED SEPARATELY, because two snapshots CANNOT express this. A change
    // adding a browser-only export would update both files and pass.
    const root = collectExports(join(SRC_DIR, 'index.ts'));
    const browser = collectExports(join(SRC_DIR, 'index.browser.ts'));
    const browserOnly = [...browser.keys()].filter((n) => !root.has(n));
    expect(browserOnly, 'browser exports something the root entry does not').toEqual([]);
    const rootOnly = [...root.keys()].filter((n) => !browser.has(n)).sort();
    expect(rootOnly).toEqual(['HttpDownloader', 'verifyWebhook']);
  });

  it('records a class as value+type, not bare value', () => {
    // 🔴 THE REGRESSION GUARD FOR CODEX FINDING 58a95ad5a502 ON PR #393. Before
    // relative re-export chains were resolved, EVERY class on the public surface —
    // `GislClient`, `Recipe`, `OperationBuilder` — was snapshotted as plain `value`,
    // because each reaches the entry through `export { X } from './y.js'`. A class ->
    // const downgrade then removed the public TYPE with no snapshot drift. If this
    // assertion fails with `value`, that resolution has been lost again.
    const root = collectExports(join(SRC_DIR, 'index.ts'));
    expect(root.get('GislClient')).toBe('value+type');
    expect(root.get('Recipe')).toBe('value+type');
    expect(root.get('OperationBuilder')).toBe('value+type');
    // The const-plus-type-alias generated enum pattern is also both namespaces.
    expect(root.get('OptimizeFor')).toBe('value+type');
    // …and a plain interface stays type-only, so the above is not a blanket upgrade.
    expect(root.get('WatermarkOptions')).toBe('type');
  });
});

/**
 * 🔴 THE TRIPWIRES, EXERCISED ON PURPOSE.
 *
 * Every export form the walker cannot model THROWS rather than recording nothing —
 * but zero instances of any of them exist in `src/`, so in normal operation not one
 * of these branches is ever reached. A guard that only ever runs on the happy path
 * has not been tested, and a no-op edit to any of them would pass the suite above
 * without a murmur. These fixtures are the only thing standing between "it throws"
 * and "we believe it throws".
 *
 * Fixtures are written to a mkdtemp dir and removed on EXIT, INT and TERM — an
 * EXIT-only cleanup does not fire on a kill, which is how runs actually get
 * interrupted.
 */
describe('walker tripwires — the forms that must fail loud', () => {
  let fixtureDir: string;

  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'gisl-api-surface-'));
  });

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  const fixture = (name: string, source: string): string => {
    const path = join(fixtureDir, name);
    writeFileSync(path, source, 'utf8');
    return path;
  };

  // ── The one form that still THROWS ──────────────────────────────────────────
  //
  // Everything else below is now a BEHAVIOUR assertion rather than a refusal: the
  // checker models those forms, so the honest test is "does it get them right",
  // not "does it decline to look". This one stays a throw because the compiler
  // host is deliberately forbidden from resolving bare specifiers, so the checker
  // would return a SHORTER list with no error — clean, and wrong.
  it('throws on a bare-specifier star export', () => {
    const entry = fixture('bare-star.ts', "export * from 'some-package';\n");
    expect(() => collectExports(entry)).toThrow(/bare-specifier star export/);
  });

  // ── The forms that were hand-modelled, and are now the compiler's job ────────
  //
  // 🔴 EACH OF THESE WAS ONCE A `throw` OR A SILENT SKIP, and each cost a review
  // round to find. They are kept as tests, not deleted, precisely because the
  // reason they pass has changed: the value is now in proving the compiler-derived
  // surface HANDLES them, so a future "simplification" back to a hand-rolled walk
  // goes red here instead of quietly under-reporting again.

  it('enumerates a destructured export', () => {
    const entry = fixture(
      'destructured.ts',
      'export const { alpha, beta } = { alpha: 1, beta: 2 };\n',
    );
    const rows = collectExports(entry);
    expect(rows.get('alpha')).toBe('value');
    expect(rows.get('beta')).toBe('value');
  });

  it('enumerates a default export declaration', () => {
    const entry = fixture('default-decl.ts', 'export default class Thing {}\n');
    expect(collectExports(entry).get('default')).toBe('value+type');
  });

  it('enumerates an exported import-equals alias', () => {
    // codex 5ce4380a11af — reached `kind === undefined` and was silently skipped.
    const entry = fixture(
      'import-equals.ts',
      'namespace Inner { export const x = 1; }\nexport import Alias = Inner;\n',
    );
    expect(collectExports(entry).has('Alias')).toBe(true);
  });

  it('refuses `export type *`, which the checker does not mark type-only', () => {
    // codex 938c78772a0e. MEASURED: getExportsOfModule returns Shape with full
    // value+type flags and emits no diagnostic, so this form cannot be recorded
    // correctly without re-implementing star semantics. Refused instead. Zero exist.
    fixture('type-star-source.ts', 'export class Shape {}\n');
    const entry = fixture('type-star.ts', "export type * from './type-star-source.js';\n");
    expect(() => collectExports(entry)).toThrow(/type-only star export/);
  });

  it('does NOT flag two barrels re-exporting ONE binding from ONE module', () => {
    // 🔴 codex 288446929433 — a guard comparing immediate specifier STRINGS threw
    // here. ES `ResolveExport` compares the resolved [module, binding] pair, so this
    // shape is legal and unambiguous, and a false positive breaks valid code — worse
    // than the under-report it replaced.
    fixture('shared-source.ts', 'export class OnlyMe {}\n');
    fixture('barrel-one.ts', "export { OnlyMe } from './shared-source.js';\n");
    fixture('barrel-two.ts', "export { OnlyMe } from './shared-source.js';\n");
    const entry = fixture(
      'two-barrels.ts',
      "export * from './barrel-one.js';\nexport * from './barrel-two.js';\n",
    );
    expect(collectExports(entry).get('OnlyMe')).toBe('value+type');
  });

  it('refuses a name star-exported from two DIFFERENT declaring modules', () => {
    // codex cde8bfdd398f. MEASURED: getExportsOfModule still returns the FIRST
    // `shared`, so absence cannot be asserted — but the checker DOES report the
    // ambiguity as TS2308, and that diagnostic is what this refusal reads.
    fixture('collide-a.ts', 'export const shared = 1;\n');
    fixture('collide-b.ts', 'export const shared = 2;\n');
    const entry = fixture(
      'collision.ts',
      "export * from './collide-a.js';\nexport * from './collide-b.js';\n",
    );
    expect(() => collectExports(entry)).toThrow(/ambiguous star export/);
  });

  it('does not invent a name for an unresolvable relative specifier', () => {
    const entry = fixture('missing-module.ts', "export { thing } from './nope.js';\n");
    const rows = collectExports(entry);
    // The module does not exist, so `thing` resolves to nothing. It must not appear
    // as a confident `value` row — that is the clean-but-wrong snapshot again.
    expect(rows.get('thing')).not.toBe('value+type');
  });

  it('still resolves a kind through a multi-hop relative chain', () => {
    // 🔴 THE POSITIVE CONTROL. Several tests above assert a THROW or an ABSENCE, and
    // a derivation that returned nothing at all would pass every one of them. This is
    // the case that must come back CORRECT, so an empty result cannot masquerade as a
    // clean run.
    fixture('hop-c.ts', 'export class Deep {}\n');
    fixture('hop-b.ts', "export { Deep } from './hop-c.js';\n");
    const entry = fixture('hop-a.ts', "export { Deep } from './hop-b.js';\n");
    expect(collectExports(entry).get('Deep')).toBe('value+type');
  });

  // ── Round 3 (P3tS8N41): the validations must cover the WHOLE graph ───────────

  it('refuses a bare-specifier star export inside a NESTED barrel', () => {
    // 🔴 codex 2bc4c94a2d1d — the checks read the ENTRY file only, and this repo's
    // entries both re-export through `index.core.ts`, so nearly every public name
    // arrives one hop in. A nested bare star vanished in silence.
    fixture('nested-bare.ts', "export * from 'some-package';\n");
    const entry = fixture('entry-nested-bare.ts', "export * from './nested-bare.js';\n");
    expect(() => collectExports(entry)).toThrow(/bare-specifier star export/);
  });

  it('refuses `export type *` inside a NESTED barrel', () => {
    fixture('deep-class.ts', 'export class Deeply {}\n');
    fixture('nested-type-star.ts', "export type * from './deep-class.js';\n");
    const entry = fixture('entry-nested-ts.ts', "export * from './nested-type-star.js';\n");
    expect(() => collectExports(entry)).toThrow(/type-only star export/);
  });

  it('refuses an ambiguous star export inside a NESTED barrel', () => {
    fixture('n-collide-a.ts', 'export const dupe = 1;\n');
    fixture('n-collide-b.ts', 'export const dupe = 2;\n');
    fixture(
      'nested-collision.ts',
      "export * from './n-collide-a.js';\nexport * from './n-collide-b.js';\n",
    );
    const entry = fixture('entry-nested-collide.ts', "export * from './nested-collision.js';\n");
    expect(() => collectExports(entry)).toThrow(/ambiguous star export/);
  });

  it('refuses `export type * as NS`, which a star check keyed on the clause misses', () => {
    // codex 0036cfc10d6b — a NamespaceExport clause made `exportClause === undefined`
    // false, so the type-star refusal never saw it.
    fixture('ns-source.ts', 'export class Inside {}\n');
    const entry = fixture('type-star-ns.ts', "export type * as Types from './ns-source.js';\n");
    expect(() => collectExports(entry)).toThrow(/type-only star export/);
  });

  it('resolves a `./x.js` specifier backed by `x.d.ts`', () => {
    // 🔴 codex 079096c07220 — the candidate list appended `.d.ts` to the RAW
    // specifier, testing `x.js.d.ts`. A whole module's public types dropped out of
    // the snapshot silently. The positive control for the stripped-base fix.
    fixture('typed.d.ts', 'export declare class FromDts {}\n');
    const entry = fixture('uses-dts.ts', "export * from './typed.js';\n");
    expect(collectExports(entry).get('FromDts')).toBe('value+type');
  });

  it('separates the value and type namespaces on a const-plus-type-alias enum', () => {
    // The second positive control: `value+type` must be EARNED, not applied blanket.
    const entry = fixture(
      'enum-pattern.ts',
      'export const Colour = { red: "red" } as const;\n' +
        'export type Colour = (typeof Colour)[keyof typeof Colour];\n' +
        'export interface OnlyAType { a: number }\n',
    );
    const rows = collectExports(entry);
    expect(rows.get('Colour')).toBe('value+type');
    expect(rows.get('OnlyAType')).toBe('type');
  });
});
