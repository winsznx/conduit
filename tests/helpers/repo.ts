import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readText(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

/**
 * Returns `unknown` on purpose. These files are inputs to the gate, so the
 * narrowing belongs at the call site where the expected shape is stated and
 * visible, not hidden behind a generic that is only ever a type assertion.
 */
export function readJson(relativePath: string): unknown {
  return JSON.parse(readText(relativePath)) as unknown;
}

export function exists(relativePath: string): boolean {
  try {
    statSync(join(ROOT, relativePath));
    return true;
  } catch {
    return false;
  }
}

export function isDirectory(relativePath: string): boolean {
  try {
    return statSync(join(ROOT, relativePath)).isDirectory();
  } catch {
    return false;
  }
}

export function listFiles(relativeDir: string, extension: string): string[] {
  const absolute = join(ROOT, relativeDir);
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && entry.name.endsWith(extension) ? [relative(ROOT, full)] : [];
    });
  return walk(absolute).sort();
}

/** Workspace directories are derived from disk, then cross-checked against pnpm-workspace.yaml. */
export function workspaceDirs(): string[] {
  return ['apps', 'packages']
    .flatMap((group) =>
      readdirSync(join(ROOT, group), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${group}/${entry.name}`),
    )
    .filter((dir) => exists(`${dir}/package.json`))
    .sort();
}

export interface Toolchain {
  manifestVersion: number;
  phase: string;
  runtime: { node: string; pnpm: string };
  solidity: { solc: string; evmVersion: string; pragma: string; knownBugsAtPin: string[] };
  foundry: { version: string; commit: string };
  solidityLibraries: Record<string, { repo: string; tag: string; commit: string }>;
  staticAnalysis: Record<string, string>;
  containerImages: Record<string, { reference: string; digest: string }>;
  terraform: { cli: string; providers: Record<string, string> };
  githubActions: Record<string, { tag: string; sha: string }>;
}

export interface PackageJson {
  name: string;
  version: string;
  private?: boolean;
  type?: string;
  description?: string;
  packageManager?: string;
  engines?: Record<string, string>;
  exports?: Record<string, unknown>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export function toolchain(): Toolchain {
  return readJson('toolchain.json') as Toolchain;
}

export function readPackageJson(relativePath: string): PackageJson {
  return readJson(relativePath) as PackageJson;
}

export function rootPackageJson(): PackageJson {
  return readPackageJson('package.json');
}
