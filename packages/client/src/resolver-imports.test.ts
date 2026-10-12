/**
 * What the resolver may import.
 *
 * The public-resolver image (`Dockerfile.dns`) runs `apps/dns-server`, which
 * imports `proxy.ts` by relative path, and contains the SOURCE of only the
 * workspace packages the Dockerfile copies. Two properties are checked on the
 * parsed import graph (type-only imports are erased and not followed):
 *
 * - Every workspace package the resolver reaches, directly or through another
 *   workspace package, is one whose source `Dockerfile.dns` copies. The list
 *   is read from the Dockerfile itself, so adding a package there satisfies
 *   the check and importing one it lacks fails it — the breakage this catches
 *   starts in production only, while every local test passes.
 * - Nothing the resolver reaches is the personal-rules store or CLI: the rules
 *   key and the decryption code belong to `tnp rules` (root), never to a
 *   daemon, and never to the public resolver (naming.md §3).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../..');

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveRelative(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  const candidates = [base, `${base}.ts`, base.replace(/\.js$/, '.ts'), join(base, 'index.ts')];
  return candidates.find(isFile) ?? null;
}

/** `@tnp/<pkg>[/<sub>]` → the source file its package.json `exports` names. */
function resolveWorkspace(specifier: string): { pkg: string; file: string } | null {
  const match = /^@tnp\/([^/]+)(\/.*)?$/.exec(specifier);
  if (!match) return null;
  const dir = join(ROOT, 'packages', match[1]);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as {
    exports?: Record<string, string>;
  };
  const target = manifest.exports?.[match[2] ? `.${match[2]}` : '.'];
  return target ? { pkg: `packages/${match[1]}`, file: join(dir, target) } : null;
}

/** Files reachable from `entry`, and the workspace packages they pull in. */
function importGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const transpiler = new Bun.Transpiler({ loader: 'ts' });
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const { path } of transpiler.scanImports(readFileSync(file, 'utf-8'))) {
      if (path.startsWith('.')) {
        const next = resolveRelative(file, path);
        if (next) queue.push(next);
        continue;
      }
      const workspace = resolveWorkspace(path);
      if (workspace) {
        packages.add(workspace.pkg);
        queue.push(workspace.file);
      }
    }
  }
  return { files, packages };
}

/** Source directories `Dockerfile.dns` copies (`COPY <dir> <dir>`, not package.json lines). */
function copiedSourceDirs(dockerfile: string): Set<string> {
  const dirs = new Set<string>();
  for (const line of dockerfile.split('\n')) {
    const match = /^COPY\s+(\S+)\s+\S+\s*$/.exec(line.trim());
    if (match && !match[1].endsWith('.json') && !match[1].endsWith('.toml')) dirs.add(match[1]);
  }
  return dirs;
}

describe('the resolver import graph', () => {
  const graph = importGraph(join(ROOT, 'apps/dns-server/src/index.ts'));
  const relative = [...graph.files].map((f) => f.slice(ROOT.length + 1));
  const copied = copiedSourceDirs(readFileSync(join(ROOT, 'Dockerfile.dns'), 'utf-8'));

  test('reaches the resolver and the personal-rules reader (vacuity floor)', () => {
    expect(relative).toContain('packages/client/src/proxy.ts');
    expect(relative).toContain('packages/client/src/dns-rules.ts');
    expect(graph.packages).toContain('packages/shared-types');
    expect(copied).toContain('packages/client');
  });

  test('every workspace package it reaches is copied into the DNS image', () => {
    const missing = [...graph.packages].filter((pkg) => !copied.has(pkg));
    expect(missing).toEqual([]);
  });

  test('never reaches the rules store, the rules CLI or anything holding the rules key', () => {
    expect(relative).not.toContain('packages/client/src/dns-rules-store.ts');
    expect(relative).not.toContain('packages/client/src/rules-cli.ts');
    expect(relative).not.toContain('packages/client/src/rules-routing.ts');
    expect(relative.some((f) => f === 'packages/crypto/src/dns-rules.ts')).toBe(false);
  });
});
