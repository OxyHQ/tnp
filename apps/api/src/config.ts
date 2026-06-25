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

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  mongoUri: process.env.MONGODB_URI || "mongodb://localhost:27017",
  dbName: `${APP_NAME}-${env}`,
  oxyApiUrl: process.env.OXY_API_URL || "https://api.oxy.so",
  parkingIp,
  corsOrigins: [
    "http://localhost:5173",
    "https://tnp.network",
    "https://www.tnp.network",
    "https://tnp-9uk.pages.dev",
  ],
};
