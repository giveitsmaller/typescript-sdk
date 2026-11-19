// Shared by the parity suites (zdbFzaNX endpoint-parity, xybG2CzQ operation-parity).
// Not a test file: importing a *.test.ts from another would re-register its tests there.
//
// Reads the BUILT package's declarations (the `types` entrypoints package.json
// exports) with the TypeScript compiler API, so a parity row is proven against
// what a consumer installs rather than against src/.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { SDKS_REPO_ROOT } from './_contract-paths.js';

export const PKG_ROOT = resolve(SDKS_REPO_ROOT, 'packages/typescript');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Copied from tests/api-surface.test.ts (createRelativeOnlyProgram and its
// helpers): bare specifiers resolve to nothing, so the read cannot depend on
// what happens to be installed in node_modules.
const COMPILER_OPTIONS: ts.CompilerOptions = {
  noLib: true,
  target: ts.ScriptTarget.Latest,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};

function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const stripped = base.replace(/\.js$/, '');
  for (const candidate of [`${stripped}.ts`, `${stripped}.d.ts`, `${base}.ts`, `${base}.d.ts`]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const isRelative = (specifier: string): boolean => specifier.startsWith('.');

export function createRelativeOnlyProgram(entryFiles: readonly string[]): ts.Program {
  const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
  host.resolveModuleNameLiterals = (literals, containingFile): ts.ResolvedModuleWithFailedLookupLocations[] =>
    literals.map((literal) => {
      const specifier = literal.text;
      if (!isRelative(specifier)) return { resolvedModule: undefined };
      const resolvedFileName = resolveRelative(containingFile, specifier);
      if (resolvedFileName === undefined) return { resolvedModule: undefined };
      return {
        resolvedModule: {
          resolvedFileName,
          extension: resolvedFileName.endsWith('.d.ts') ? ts.Extension.Dts : ts.Extension.Ts,
        },
      };
    });
  return ts.createProgram([...entryFiles], COMPILER_OPTIONS, host);
}

/** Every `types` path package.json exposes under `exports`, plus top-level `types`. */
export function typesEntrypoints(): string[] {
  const manifest: unknown = JSON.parse(readFileSync(resolve(PKG_ROOT, 'package.json'), 'utf8'));
  if (!isRecord(manifest)) throw new Error('package.json is not an object');
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (!isRecord(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'types' && typeof value === 'string') found.add(value);
      else walk(value);
    }
  };
  walk(manifest.exports);
  if (typeof manifest.types === 'string') found.add(manifest.types);
  return [...found].map((relative) => resolve(PKG_ROOT, relative)).sort();
}

// One program per entrypoint per test file. Building it is seconds of synchronous
// compiler work on a loaded runner, and every reader asks several names of the same
// entry; sharing it keeps a parity test from paying that cost once per name.
const entryPrograms = new Map<string, ts.Program>();

function entryProgram(entryFile: string): ts.Program {
  let program = entryPrograms.get(entryFile);
  if (program === undefined) {
    program = createRelativeOnlyProgram([entryFile]);
    entryPrograms.set(entryFile, program);
  }
  return program;
}

/**
 * Per-test timeout for a test whose body can be the first to build a file's built
 * surface. Measured: the first build costs 1-2 s quiet and 5-23 s at 0.25 CPU, past
 * vitest's 5000 ms default, and a synchronous test is failed after it returns, so the
 * timeout must cover the build. The global testTimeout is deliberately left alone.
 */
export const BUILT_SURFACE_TIMEOUT_MS = 30_000;

/** The declarations of the symbol `entryFile` exports as `name`, followed through every alias. */
function exportedDeclarations(entryFile: string, name: string): ts.Declaration[] {
  const program = entryProgram(entryFile);
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(entryFile);
  if (sourceFile === undefined) throw new Error(`${entryFile}: not in the program`);
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol === undefined) throw new Error(`${entryFile}: no module symbol`);

  const exported = checker.getExportsOfModule(moduleSymbol).find((s) => s.getName() === name);
  if (exported === undefined) throw new Error(`${entryFile}: does not export ${name}`);
  const target =
    (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported;
  return target.declarations ?? [];
}

/**
 * Public, non-static method names of the class `className` that `entryFile`
 * exports, followed through every alias. Private members are emitted into a
 * .d.ts as property declarations (`private foo;`), so filtering on
 * MethodDeclaration plus the modifier check is what makes this "public".
 */
export function publicClassMethods(entryFile: string, className: string): Set<string> {
  const classDeclaration = exportedDeclarations(entryFile, className).find(
    (declaration): declaration is ts.ClassDeclaration => ts.isClassDeclaration(declaration),
  );
  if (classDeclaration === undefined) {
    throw new Error(`${entryFile}: ${className} does not resolve to a class declaration`);
  }

  const methods = new Set<string>();
  for (const member of classDeclaration.members) {
    if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
    const flags = ts.getCombinedModifierFlags(member);
    if ((flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Static)) !== 0) {
      continue;
    }
    methods.add(member.name.text);
  }
  return methods;
}

/**
 * Member names declared by the TYPE-LITERAL half of the type alias `aliasName`
 * that `entryFile` exports, when that alias is an intersection such as
 * `type ErgonomicClient = GislClient & { file(...): Recipe; ... }`. The named
 * halves (`GislClient`) are NOT read, so a same-named member on them cannot
 * stand in for one the literal declares.
 */
export function intersectionLiteralMembers(entryFile: string, aliasName: string): Set<string> {
  const alias = exportedDeclarations(entryFile, aliasName).find(
    (declaration): declaration is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(declaration),
  );
  if (alias === undefined || !ts.isIntersectionTypeNode(alias.type)) {
    throw new Error(`${entryFile}: ${aliasName} does not resolve to an intersection type alias`);
  }
  const literals = alias.type.types.filter((node): node is ts.TypeLiteralNode => ts.isTypeLiteralNode(node));
  if (literals.length === 0) throw new Error(`${entryFile}: ${aliasName} has no type-literal half`);

  const members = new Set<string>();
  for (const literal of literals) {
    for (const member of literal.members) {
      if (!ts.isMethodSignature(member) && !ts.isPropertySignature(member)) continue;
      if (ts.isIdentifier(member.name)) members.add(member.name.text);
    }
  }
  return members;
}
