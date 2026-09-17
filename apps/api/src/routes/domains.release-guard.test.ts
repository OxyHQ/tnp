/**
 * `DELETE /domains/:id` is the explicit release of a native name. It deletes
 * the registration, its records and its service node, and makes the name
 * registrable by anyone. Issue #62 (finding A7) forbids reusing it for anything
 * in the services layer — cancelling a public domain, ending hosting, a
 * transfer, "don't renew" — because each of those is a different, usually
 * reversible, operation.
 *
 * This guard fails if any source file under `src/services/` imports the
 * domains router or deletes from the `domains` table. `src/services/` may not
 * exist yet; the controls below show the matcher would see a violation if it
 * did, so an empty scan is evidence rather than blindness.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..");
const SERVICES = join(SRC, "services");

/** Comments removed first: a comment explaining the rule must not trip it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const FORBIDDEN: ReadonlyArray<[string, RegExp]> = [
  ["imports the domains router", /from\s+["'][^"']*routes\/domains(\.js)?["']/],
  ["deletes from the domains table", /\.delete\(\s*domains\s*\)/],
  ["deletes from domains in raw SQL", /delete\s+from\s+"?domains"?\b/i],
];

function violations(source: string): string[] {
  const code = stripComments(source);
  return FORBIDDEN.filter(([, pattern]) => pattern.test(code)).map(([label]) => label);
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => /\.(ts|tsx|js|mjs)$/.test(path))
    .map((path) => join(dir, path));
}

describe("native release is never reused by the services layer", () => {
  test("positive control: the matcher sees the real release in routes/domains.ts", () => {
    const route = readFileSync(join(SRC, "routes", "domains.ts"), "utf8");
    expect(violations(route)).toContain("deletes from the domains table");
    expect(violations(`import router from "../routes/domains.js";`)).toEqual([
      "imports the domains router",
    ]);
    expect(violations(`await sql\`DELETE FROM domains WHERE id = \${id}\``)).toEqual([
      "deletes from domains in raw SQL",
    ]);
  });

  test("negative control: prose about the rule is not a violation", () => {
    expect(
      violations(`// never call db.delete(domains) from here\n/* delete from domains */\nexport {};`),
    ).toEqual([]);
  });

  test("no file under src/services deletes a native registration", () => {
    const files = sourceFiles(SERVICES);
    const found = files.flatMap((file) =>
      violations(readFileSync(file, "utf8")).map((label) => `${file}: ${label}`),
    );
    expect(found).toEqual([]);
  });
});
