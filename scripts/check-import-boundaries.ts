#!/usr/bin/env bun

/**
 * Keeps the optional services layer from becoming a dependency of TNP Network
 * (docs/architecture/services.md §2).
 *
 * The rule the ADR states in prose is enforced on parsed imports — Bun's own
 * transpiler scans each file, so an import inside a comment or a string cannot
 * satisfy or trip the check the way a grep would.
 *
 *   - Nothing outside `apps/api/src/services/`, `apps/api/src/workers/` and the
 *     API's tests may import from `apps/api/src/services/`, except
 *     `apps/api/src/index.ts`, which may import only `services/routes.ts` and
 *     `services/config.ts`.
 *   - No production file may import `services/providers/testing/`.
 *
 * Vacuity floors: the scan must read a minimum number of files, and must see
 * the one allowed edge (`index.ts` → `services/routes.ts`). A checker that
 * resolved nothing would otherwise report a clean tree forever.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const SCANNED_ROOTS = ["apps", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "public", "drizzle", "fixtures"]);
const SOURCE_RE = /\.(tsx|ts|mts|mjs|js)$/;
const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

export interface BoundaryResult {
  readonly scanned: number;
  readonly violations: readonly string[];
  readonly sawAllowedEntry: boolean;
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (SOURCE_RE.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
}

function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  const candidates = [base, base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), ...RESOLVE_EXTENSIONS.map((ext) => base + ext)];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next form
    }
  }
  return base;
}

const toPosix = (p: string) => p.split(sep).join("/");

export function checkImportBoundaries(root: string): BoundaryResult {
  const files: string[] = [];
  for (const dir of SCANNED_ROOTS) walk(join(root, dir), files);

  const services = "apps/api/src/services/";
  const testing = "apps/api/src/services/providers/testing/";
  // The loader follows the extension: parsed as TSX, `<T>(x: T) => x` in a
  // plain `.ts` file is a JSX element and the scan fails.
  const transpilers = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }), js: new Bun.Transpiler({ loader: "js" }) };
  const violations: string[] = [];
  let sawAllowedEntry = false;

  for (const file of files) {
    const from = toPosix(relative(root, file));
    const isTest = /\.test\.tsx?$/.test(from) || from.startsWith("apps/api/test-db/") || from.startsWith("apps/api/test-sandbox/");
    let imports: { path: string }[];
    try {
      // A shebang line is valid for Bun to execute but not for the scanner.
      const transpiler = file.endsWith(".tsx") ? transpilers.tsx : /\.(mjs|js)$/.test(file) ? transpilers.js : transpilers.ts;
      imports = transpiler.scanImports(readFileSync(file, "utf8").replace(/^#!.*/, ""));
    } catch (err) {
      violations.push(`${from}: could not be parsed (${String(err)})`);
      continue;
    }

    for (const { path } of imports) {
      const target = resolveImport(file, path);
      if (!target) continue;
      const to = toPosix(relative(root, target));
      if (!to.startsWith(services)) continue;

      if (to.startsWith(testing) && !isTest && !from.startsWith(testing)) {
        violations.push(`${from} imports the test-only adapter ${to}`);
        continue;
      }
      if (from.startsWith(services) || from.startsWith("apps/api/src/workers/") || isTest) continue;
      if (from === "apps/api/src/index.ts") {
        if (to === `${services}routes.ts` || to === `${services}config.ts`) {
          if (to === `${services}routes.ts`) sawAllowedEntry = true;
          continue;
        }
        violations.push(`${from} may import only services/routes.ts and services/config.ts, not ${to}`);
        continue;
      }
      violations.push(`${from} imports ${to}: the network must not depend on the services layer`);
    }
  }

  return { scanned: files.length, violations, sawAllowedEntry };
}

const MIN_SCANNED = 80;

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const result = checkImportBoundaries(root);
  const problems = [...result.violations];
  if (result.scanned < MIN_SCANNED) problems.push(`scanned only ${result.scanned} files (floor ${MIN_SCANNED}); the walk is broken`);
  if (!result.sawAllowedEntry) problems.push("did not observe apps/api/src/index.ts importing services/routes.ts; import resolution is broken");
  if (problems.length > 0) {
    for (const p of problems) console.error(`  fail ${p}`);
    process.exit(1);
  }
  console.log(`  ok   ${result.scanned} files, no services-layer boundary violations`);
}
