/**
 * Regenerate `src/iana-root-zone.ts` from the IANA root zone database.
 *
 * The reserved-TLD set is the mechanism that keeps TNP from claiming a label
 * the public DNS root already delegates (docs/architecture/naming.md, rule N1).
 * A stale list is a real collision risk: a TLD delegated by IANA *after*
 * somebody registered it in TNP is exactly the case that rule exists to
 * prevent, and it is only recoverable through the migration in §6.
 *
 * Run periodically:  bun run --filter '@tnp/namespace' refresh-iana
 *
 * The snapshot is committed rather than fetched at runtime: classification must
 * be offline and deterministic (rule N4), and a resolver that phones home to
 * decide whether a name is TNP's leaks every lookup the user makes.
 */

import { writeFileSync } from "fs";
import { join } from "path";

const SOURCE_URL = "https://data.iana.org/TLD/tlds-alpha-by-domain.txt";
const OUTPUT = join(import.meta.dir, "..", "src", "iana-root-zone.ts");

/** Below this, assume the fetch was truncated or the format changed. */
const MIN_PLAUSIBLE_TLD_COUNT = 1000;

const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(30_000) });
if (!response.ok) {
  throw new Error(`IANA returned ${response.status} ${response.statusText}`);
}

const body = await response.text();
const lines = body.split("\n").map((line) => line.trim());

const versionLine = lines.find((line) => line.startsWith("#"));
if (!versionLine) {
  throw new Error("No version comment in the IANA response; the format has changed.");
}

const tlds = lines
  .filter((line) => line.length > 0 && !line.startsWith("#"))
  .map((line) => line.toLowerCase());

// A silently truncated fetch would quietly shrink the reserved set, which fails
// open: TNP would start accepting registrations under real public TLDs again.
if (tlds.length < MIN_PLAUSIBLE_TLD_COUNT) {
  throw new Error(
    `Only ${tlds.length} TLDs parsed, expected at least ${MIN_PLAUSIBLE_TLD_COUNT}. Refusing to write a truncated list.`,
  );
}

const invalid = tlds.filter((tld) => !/^(xn--)?[a-z0-9-]+$/.test(tld));
if (invalid.length > 0) {
  throw new Error(`Unexpected TLD syntax from IANA: ${invalid.slice(0, 5).join(", ")}`);
}

writeFileSync(
  OUTPUT,
  `// GENERATED FILE — do not edit by hand.
// Regenerate with: bun run --filter '@tnp/namespace' refresh-iana
//
// Source: ${SOURCE_URL}
// ${versionLine.replace(/^#\s*/, "")}

/** Every TLD delegated by the public DNS root at the time of the snapshot above. */
export const IANA_ROOT_ZONE_TLDS: readonly string[] = [
${tlds.map((tld) => `  ${JSON.stringify(tld)},`).join("\n")}
];
`,
);

console.log(`Wrote ${tlds.length} TLDs to ${OUTPUT}`);
console.log(versionLine);
