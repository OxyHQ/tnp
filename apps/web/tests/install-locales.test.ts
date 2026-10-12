import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Every locale's install.json must carry exactly the keys en does, with the
// same interpolation variables and markup tags in each string, and every key
// en carries must be one Install.tsx asks for. A key missing from a locale
// silently renders the English fallback; a dropped <code> or {{dnsIp}} renders
// a broken instruction; a stale key keeps advice the page no longer gives.
const localesDir = join(import.meta.dir, '..', 'public', 'locales');
const pageSource = readFileSync(join(import.meta.dir, '..', 'src', 'pages', 'Install.tsx'), 'utf8');
const locales = readdirSync(localesDir).sort();
const load = (lng: string) =>
  JSON.parse(readFileSync(join(localesDir, lng, 'install.json'), 'utf8')) as unknown;

/** Every key path, arrays included as `path.N`, mapped to its value. */
function flatten(value: unknown, path = '', out = new Map<string, unknown>()) {
  if (Array.isArray(value)) {
    out.set(`${path}[]`, value.length);
    value.forEach((v, i) => {
      flatten(v, `${path}.${i}`, out);
    });
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) flatten(v, path ? `${path}.${k}` : k, out);
  } else {
    out.set(path, value);
  }
  return out;
}

/** The paths the page renders as a unit: strings, and whole arrays. */
function leaves(value: unknown, path = '', out: string[] = []): string[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) leaves(v, path ? `${path}.${k}` : k, out);
  } else {
    out.push(path);
  }
  return out;
}

const placeholders = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();
const tags = (s: string) => [...s.matchAll(/<\/?(\w+)>/g)].map((m) => m[0]).sort();

const en = flatten(load('en'));

describe('install.json locale parity', () => {
  test('all five locales are present', () => {
    expect(locales).toEqual(['en', 'es', 'fr', 'hi', 'zh']);
  });

  for (const lng of locales.filter((l) => l !== 'en')) {
    test(`${lng}: same keys as en`, () => {
      const other = flatten(load(lng));
      expect([...other.keys()].sort()).toEqual([...en.keys()].sort());
    });

    test(`${lng}: same placeholders and tags in every string`, () => {
      const other = flatten(load(lng));
      for (const [key, value] of en) {
        if (typeof value !== 'string') continue;
        const translated = String(other.get(key) ?? '');
        expect({ key, vars: placeholders(translated) }).toEqual({ key, vars: placeholders(value) });
        expect({ key, tags: tags(translated) }).toEqual({ key, tags: tags(value) });
      }
    });
  }
});

describe('install.json keys used by Install.tsx', () => {
  const literal = new Set(
    [...pageSource.matchAll(/['"]install:([\w.]+)['"]/g)].map((m) => m[1] as string),
  );
  const templates = [...pageSource.matchAll(/`install:([^`]+)`/g)].map(
    (m) =>
      new RegExp(
        `^${(m[1] as string)
          .split(/\$\{[^}]+\}/)
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^.]+')}$`,
      ),
  );
  const enLeaves = leaves(load('en'));

  test('every literal key the page asks for exists in en', () => {
    expect(literal.size).toBeGreaterThan(20);
    for (const key of literal)
      expect({ key, found: enLeaves.includes(key) }).toEqual({ key, found: true });
  });

  test('every key in en is used by the page', () => {
    for (const key of enLeaves) {
      const used = literal.has(key) || templates.some((re) => re.test(key));
      expect({ key, used }).toEqual({ key, used: true });
    }
  });
});
