#!/usr/bin/env bun

/**
 * Mutation-tests `check-import-boundaries.ts` on throwaway trees: each case
 * adds exactly one import and requires the checker to flag it — or, for the
 * allowed shapes, not to.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkImportBoundaries } from "./check-import-boundaries.ts";

type Tree = Record<string, string>;

const BASE: Tree = {
  "apps/api/src/index.ts": 'import { createProductionServicesRouter } from "./services/routes.js";\nimport { readServicesConfig } from "./services/config.js";\n',
  "apps/api/src/services/routes.ts": 'import { x } from "./providers/registry.js";\nexport const r = x;\n',
  "apps/api/src/services/config.ts": "export const c = 1;\n",
  "apps/api/src/services/providers/registry.ts": "export const x = 1;\n",
  "apps/api/src/services/providers/testing/memoryProvider.ts": 'import { x } from "../registry.js";\nexport const m = x;\n',
  "apps/api/src/workers/commerce.ts": 'import { x } from "../services/providers/registry.js";\n',
  "apps/api/src/routes/dns.ts": "// import { x } from \"../services/providers/registry.js\" — a comment is not an import\nexport const dns = 1;\n",
  "apps/api/test-db/services.test.ts": 'import { m } from "../src/services/providers/testing/memoryProvider.js";\n',
};

function run(name: string, extra: Tree, expectViolation: RegExp | null): boolean {
  const root = mkdtempSync(join(tmpdir(), "tnp-boundaries-"));
  try {
    for (const [path, content] of Object.entries({ ...BASE, ...extra })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const result = checkImportBoundaries(root);
    const matched = expectViolation ? result.violations.some((v) => expectViolation.test(v)) : result.violations.length === 0;
    const ok = matched && result.sawAllowedEntry;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — violations: ${JSON.stringify(result.violations)}, sawAllowedEntry: ${result.sawAllowedEntry}`}`);
    return ok;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const results = [
  run("the allowed shapes pass, and a commented import is not an import", {}, null),
  run("a network route importing the services layer fails", { "apps/api/src/routes/domains.ts": 'import { x } from "../services/providers/registry.js";\n' }, /routes\/domains\.ts imports/),
  run("the DNS server reaching into the API services fails", { "apps/dns-server/src/index.ts": 'import { c } from "../../api/src/services/config.js";\n' }, /dns-server\/src\/index\.ts imports/),
  run("a package importing the services layer fails", { "packages/client/src/api.ts": 'import { c } from "../../../apps/api/src/services/config";\n' }, /packages\/client\/src\/api\.ts imports/),
  run("index.ts importing anything beyond routes/config fails", { "apps/api/src/index.ts": `${BASE["apps/api/src/index.ts"]}import { x } from "./services/providers/registry.js";\n` }, /may import only/),
  run("production services code importing the test adapter fails", { "apps/api/src/services/providers/production.ts": 'import { m } from "./testing/memoryProvider.js";\n' }, /test-only adapter/),
  run("a dynamic import is still an import", { "apps/api/src/routes/nodes.ts": 'export async function f() { return import("../services/config.js"); }\n' }, /routes\/nodes\.ts imports/),
];

if (results.includes(false)) process.exit(1);
console.log("\nAll import-boundary self-test cases passed.");
