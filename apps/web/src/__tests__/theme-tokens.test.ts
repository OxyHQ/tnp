import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * The app must consume Bloom's design tokens directly, never alias them.
 *
 * Three separate colour bugs shipped from this app before this test existed,
 * all the same shape — a name pointing at a role it does not mean:
 *
 *  1. Seventeen hand-declared `--color-*` values, eleven colliding with names
 *     Bloom owns, so the rendered palette was partly the app's and partly
 *     Bloom's depending on which names overlapped.
 *  2. `text-muted` and `text-accent` used as TEXT while Bloom defines both as
 *     SURFACE tones — 1.14:1 against the card, i.e. invisible.
 *  3. `--color-surface-hover` aliased to `--secondary`, a bright foreground
 *     accent, so hovering a card flashed it near-cyan.
 *
 * Mention's global.css carries the same warning from the same failure.
 */

const SRC = join(import.meta.dir, "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (entry.name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

const FILES = sourceFiles(SRC);
const SOURCES = FILES.map((f) => readFileSync(f, "utf-8"));
const CSS = readFileSync(join(SRC, "index.css"), "utf-8");

/** The `@theme` block's contents, or "" if absent. */
const themeBlock = /@theme\s*\{([\s\S]*?)\n\}/.exec(CSS)?.[1] ?? "";

describe("the app scans enough files to be a real check", () => {
  test("finds the component tree", () => {
    // Without a floor a broken traversal passes every assertion below silently.
    expect(FILES.length).toBeGreaterThan(10);
    expect(SOURCES.join("")).toContain("className");
  });
});

describe("Bloom is the single source of colour", () => {
  test("the app declares no colour tokens of its own", () => {
    const declared = [...themeBlock.matchAll(/--color-[a-z0-9-]+/g)].map((m) => m[0]);
    expect(declared).toEqual([]);
  });

  test("Bloom's token map is imported", () => {
    expect(CSS).toContain("@oxyhq/bloom/design-tokens/theme.css");
  });

  test("no base token is wrapped in hsl()", () => {
    // The base token already resolves to a full colour; double-wrapping yields
    // an invalid value and the utility renders transparent.
    expect(CSS).not.toMatch(/hsl\(\s*var\(/);
  });
});

describe("surface roles are never used as text", () => {
  // Bloom pairs each of these with a `-foreground` member precisely because
  // the token itself is the surface, not the text on it.
  const SURFACE_ONLY = ["accent", "muted", "card", "background", "surface", "popover", "sidebar"];

  for (const role of SURFACE_ONLY) {
    test(`text-${role} is not used`, () => {
      const pattern = new RegExp(`\\b(hover:|focus:|group-hover:|active:)?text-${role}\\b(?!-)`, "g");
      const offenders = FILES.filter((_, i) => pattern.test(SOURCES[i]));
      expect(offenders.map((f) => f.replace(SRC, "src"))).toEqual([]);
    });
  }
});

describe("no colour bypasses the theme", () => {
  test("no Tailwind palette classes", () => {
    const pattern =
      /\b(bg|text|border|ring|from|to|via|fill|stroke)-(red|green|blue|yellow|orange|purple|pink|gray|grey|slate|zinc|neutral|stone|amber|lime|emerald|teal|cyan|sky|indigo|violet|fuchsia|rose)-\d{2,3}\b/g;
    const offenders = FILES.filter((_, i) => pattern.test(SOURCES[i]));
    expect(offenders.map((f) => f.replace(SRC, "src"))).toEqual([]);
  });

  test("no literal white or black backgrounds", () => {
    const pattern = /\b(hover:|focus:)?bg-(white|black)(\/\d+)?\b/g;
    const offenders = FILES.filter((_, i) => pattern.test(SOURCES[i]));
    expect(offenders.map((f) => f.replace(SRC, "src"))).toEqual([]);
  });

  test("no hex literals outside the theme seed", () => {
    const offenders = FILES.filter(
      (f, i) => /#[0-9a-fA-F]{6}\b/.test(SOURCES[i]) && !f.endsWith("main.tsx"),
    );
    expect(offenders.map((f) => f.replace(SRC, "src"))).toEqual([]);
  });
});
