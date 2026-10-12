import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Every locale's vpn.json must carry exactly the keys en does, with the same
// interpolation variables and markup tags in each string, and every key en
// carries must be one Vpn.tsx asks for. On this page a missing translation is
// worse than untidy: the honesty statement (what the exit operator can see,
// that this is not anonymity) must reach every reader in their language, and a
// dropped {{ipv4}} or <code> turns a router instruction into a wrong one.
const localesDir = join(import.meta.dir, '..', 'public', 'locales');
const pageSource = readFileSync(join(import.meta.dir, '..', 'src', 'pages', 'Vpn.tsx'), 'utf8');
const locales = readdirSync(localesDir).sort();
const load = (lng: string, ns = 'vpn') =>
  JSON.parse(readFileSync(join(localesDir, lng, `${ns}.json`), 'utf8')) as unknown;

function flatten(value: unknown, path = '', out = new Map<string, unknown>()) {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) flatten(v, path ? `${path}.${k}` : k, out);
  } else {
    out.set(path, value);
  }
  return out;
}

const placeholders = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();
const tags = (s: string) => [...s.matchAll(/<\/?(\w+)>/g)].map((m) => m[0]).sort();

const en = flatten(load('en'));

describe('vpn.json locale parity', () => {
  test('all five locales are present', () => {
    expect(locales).toEqual(['en', 'es', 'fr', 'hi', 'zh']);
  });

  for (const lng of locales.filter((l) => l !== 'en')) {
    test(`${lng}: same keys as en`, () => {
      expect([...flatten(load(lng)).keys()].sort()).toEqual([...en.keys()].sort());
    });

    test(`${lng}: same placeholders and tags in every string, and actually translated`, () => {
      const other = flatten(load(lng));
      let identical = 0;
      for (const [key, value] of en) {
        if (typeof value !== 'string') continue;
        const translated = String(other.get(key) ?? '');
        expect({ key, vars: placeholders(translated) }).toEqual({ key, vars: placeholders(value) });
        expect({ key, tags: tags(translated) }).toEqual({ key, tags: tags(value) });
        if (translated === value) identical++;
      }
      // Product names and "{{id}} ({{region}})" may stay as they are; prose may not.
      expect(identical).toBeLessThan(12);
    });
  }

  test('the honesty statement names the exit operator and refuses an anonymity claim, in every locale', () => {
    for (const lng of locales) {
      const strings = flatten(load(lng));
      for (const key of ['honesty.not1', 'honesty.not2', 'honesty.tor']) {
        expect({ lng, key, present: String(strings.get(key) ?? '').length > 40 }).toEqual({
          lng,
          key,
          present: true,
        });
      }
    }
    // English, where the wording rules are written (privacy-model.md §6).
    const all = [...en.values()].join(' ').toLowerCase();
    for (const forbidden of [
      'untraceable',
      'military-grade',
      'guaranteed privacy',
      'absolute privacy',
    ]) {
      expect(all).not.toContain(forbidden);
    }
    expect(String(en.get('honesty.not2'))).toContain('This is not anonymity');
    expect(String(en.get('honesty.tor'))).toContain('Tor Browser');
  });

  test('the other dashboard tabs link the VPN page in every locale', () => {
    for (const lng of locales) {
      for (const ns of ['dashboard', 'serviceNodes', 'dnsRules']) {
        expect({ lng, ns, vpn: flatten(load(lng, ns)).get('tabs.vpn') }).toEqual({
          lng,
          ns,
          vpn: 'VPN',
        });
      }
    }
  });
});

describe('vpn.json keys used by Vpn.tsx', () => {
  // `t('vpn:a.b')`, `t('a.b')` inside components bound to the vpn namespace,
  // `i18nKey="a.b"` and key lists — every quoted dotted key in the source.
  const literal = new Set([
    ...[...pageSource.matchAll(/['"]vpn:([a-z]\w*(?:\.\w+)*)['"]/g)].map((m) => m[1] as string),
    ...[...pageSource.matchAll(/['"]([a-z]\w*(?:\.\w+)+)['"]/g)].map((m) => m[1] as string),
  ]);
  const templates = [...pageSource.matchAll(/`(?:vpn:)?([a-z]\w*\.[\w.]*\$\{[^}]+\}[\w.]*)`/g)].map(
    (m) =>
      new RegExp(
        `^${(m[1] as string)
          .split(/\$\{[^}]+\}/)
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^.]+')}$`,
      ),
  );
  const keys = [...en.keys()];

  test('every key the page asks for exists in en', () => {
    expect(literal.size).toBeGreaterThan(40);
    for (const key of literal) {
      expect({ key, found: keys.includes(key) }).toEqual({ key, found: true });
    }
  });

  test('every key in en is used by the page', () => {
    for (const key of keys) {
      const used = literal.has(key) || templates.some((re) => re.test(key));
      expect({ key, used }).toEqual({ key, used: true });
    }
  });
});
