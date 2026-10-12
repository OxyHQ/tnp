/**
 * What the resolver may import.
 *
 * The public-resolver image (`Dockerfile.dns`) copies the source of only the
 * client, namespace, protocol and shared-types packages, and runs
 * `apps/dns-server`, which imports `proxy.ts` by relative path. Two things
 * follow, and both are checked on the parsed import graph here:
 *
 * - Nothing the resolver reaches may import `@tnp/crypto`: its source is not
 *   in that image, so such an import fails at start-up in production while
 *   every local test passes.
 * - Nothing the resolver reaches may import the personal-rules store: the
 *   rules key and the decryption code belong to `tnp rules` (root), never to
 *   a daemon, and never to the public resolver.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../..');

function resolveRelative(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    base.replace(/\.js$/, '.ts'),
    join(base, 'index.ts'),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // next
    }
  }
  return null;
}

/** Every file reachable from `entry` by relative import, and every bare specifier they import. */
function importGraph(entry: string): { files: Set<string>; bare: Map<string, string> } {
  const transpiler = new Bun.Transpiler({ loader: 'ts' });
  const files = new Set<string>();
  const bare = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const { path } of transpiler.scanImports(readFileSync(file, 'utf-8'))) {
      if (path.startsWith('.')) {
        const next = resolveRelative(file, path);
        if (next) queue.push(next);
      } else if (!bare.has(path)) {
        bare.set(path, file);
      }
    }
  }
  return { files, bare };
}

describe('the resolver import graph', () => {
  const graph = importGraph(join(ROOT, 'apps/dns-server/src/index.ts'));

  test('reaches the resolver and the personal-rules reader (vacuity floor)', () => {
    const names = [...graph.files].map((f) => f.slice(ROOT.length + 1));
    expect(names).toContain('packages/client/src/proxy.ts');
    expect(names).toContain('packages/client/src/dns-rules.ts');
  });

  test('never imports @tnp/crypto, whose source the DNS image does not contain', () => {
    const offenders = [...graph.bare].filter(
      ([spec]) => spec === '@tnp/crypto' || spec.startsWith('@tnp/crypto/'),
    );
    expect(offenders).toEqual([]);
  });

  test('never reaches the rules store, the rules CLI or anything holding the rules key', () => {
    const names = [...graph.files].map((f) => f.slice(ROOT.length + 1));
    expect(names).not.toContain('packages/client/src/dns-rules-store.ts');
    expect(names).not.toContain('packages/client/src/rules-cli.ts');
  });
});
