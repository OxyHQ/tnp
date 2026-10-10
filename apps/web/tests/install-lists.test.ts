import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Install.tsx keys each list item by its own text, so every list in
// install.json must hold distinct entries in every locale. A duplicate would
// give two siblings the same React key.
const localesDir = join(import.meta.dir, '..', 'public', 'locales');
const locales = readdirSync(localesDir);

function arrays(value: unknown, path: string, out: [string, unknown[]][]): void {
  if (Array.isArray(value)) out.push([path, value]);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) arrays(v, path ? `${path}.${k}` : k, out);
  }
}

describe('install.json lists', () => {
  test('there are locales to check', () => {
    expect(locales.length).toBeGreaterThan(0);
  });

  for (const lng of locales) {
    test(`${lng}: every list has distinct entries`, () => {
      const json = JSON.parse(readFileSync(join(localesDir, lng, 'install.json'), 'utf8'));
      const found: [string, unknown[]][] = [];
      arrays(json, '', found);
      expect(found.length).toBeGreaterThan(5);
      for (const [path, list] of found) {
        expect({ path, size: new Set(list).size }).toEqual({ path, size: list.length });
      }
    });
  }
});
