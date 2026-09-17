import dotenv from "dotenv";
dotenv.config();

const APP_NAME = "tnp";
const env = process.env.NODE_ENV || "development";

// Public DNS / parking IP for TNP domains. MUST be provided via TNP_PARKING_IP.
// This is the address clients are pointed at and the A record we hand out for
// parked/custom TLDs — i.e. a security-critical value for a DNS product. There
// is intentionally NO hardcoded fallback: a stale literal (e.g. a retired host)
// would silently route every TNP query to a dead-or-attacker-controlled IP.
// When unset, parking answers are simply omitted (see routes/dns.ts) rather
// than pointing traffic at a wrong host.
//
// DEPLOY REQUIREMENT: set TNP_PARKING_IP to the AWS NLB Elastic IP once the
// dns-server NLB is provisioned (oxy-infra app-tnp.tf is pending).
const parkingIp = process.env.TNP_PARKING_IP?.trim() ?? "";
if (!parkingIp) {
  console.warn(
    "[tnp-api] TNP_PARKING_IP is not set — parking/custom-TLD A records will be omitted. " +
      "Set it to the TNP public DNS NLB Elastic IP before serving production traffic.",
  );
}

/**
 * Whether expired native names stop being served (docs/architecture/naming.md
 * §4). Off unless set to exactly `true`: turning it on retroactively applies
 * expiry to registrations whose owners were never told their names expire,
 * which issue #62 forbids without an approved communication first. With it off
 * the policy is still computed, shown to owners and renewable — only the
 * resolver and parking page ignore it.
 */
export function parseExpiryEnforced(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export const config = {
  // Local dev default only — ECS injects PORT explicitly (oxy-infra
  // terraform-uswest2/app-tnp.tf sets it to 8080). 4170 is TNP's slot in the
  // per-app port map so several Oxy backends can run side by side.
  port: parseInt(process.env.PORT || "4170", 10),
  /**
   * PostgreSQL connection string. No default: a wrong database is worse than a
   * missing one, and every other Oxy backend fails fast on this too.
   */
  databaseUrl: process.env.DATABASE_URL ?? "",
  postgresMaxPoolSize: parseInt(process.env.POSTGRES_MAX_POOL_SIZE || "10", 10),
  oxyApiUrl: process.env.OXY_API_URL || "https://api.oxy.so",
  parkingIp,
  nativeExpiryEnforced: parseExpiryEnforced(process.env.TNP_NATIVE_EXPIRY_ENFORCED),
  corsOrigins: [
    "http://localhost:8170",
    "https://tnp.network",
    "https://www.tnp.network",
    "https://tnp-9uk.pages.dev",
  ],
};
