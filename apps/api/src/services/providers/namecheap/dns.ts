/**
 * Namecheap `DnsAdapter` over `domains.dns.getHosts` / `domains.dns.setHosts`.
 *
 * setHosts is a full replace: "All host records that are not included into
 * the API call will be deleted"
 * (https://www.namecheap.com/support/api/methods/domains-dns/set-hosts/). There
 * is no version, etag or compare-and-swap parameter, so this adapter cannot
 * detect an edit made in Namecheap's panel between a read and a write. The
 * apply planner's re-read narrows that window; nothing here closes it.
 */

import type {
  AdapterCallContext,
  DnsAdapter,
  ProviderAccountRef,
  Zone,
  ZoneRecord,
} from "../contracts.js";
import { ProviderError } from "../errors.js";
import type { PublicDomainName } from "../../publicNames.js";
import { NAMECHEAP_DNS_CAPABILITIES } from "./capabilities.js";
import type { NamecheapClient } from "./client.js";
import { XmlRejected, attr, children, optionalBool, parseIntStrict, requireAttr, requireChild } from "./xml.js";

/**
 * Types whose every field survives a getHosts → setHosts round trip as
 * Name/Type/Address/TTL(/MXPref). Documented but excluded: `CAA` (setHosts
 * lists separate Flag/Tag parameters that getHosts does not return), `NS`
 * (delegating a label away is not an edit TNP makes blind), `ALIAS` and `MXE`
 * (Namecheap-specific, interacting with `EmailType`). services.md §6: a type
 * appears only once implemented and validated.
 */
export const NAMECHEAP_RECORD_TYPES: readonly string[] = ["A", "AAAA", "CNAME", "MX", "TXT", "URL", "URL301", "FRAME"];

/** "Possible values: any value between 60 to 60000." */
const MIN_TTL = 60;
const MAX_TTL = 60_000;
const DEFAULT_TTL = 1800;

const EMAIL_TYPE_SETTING = "EmailType";
/** Hosts are sent as form fields, so only emptiness, whitespace and length are refused. */
const HOST_RE = /^[^\s\0]{1,253}$/;

export class NamecheapDns implements DnsAdapter {
  readonly adapter = "namecheap";
  readonly capabilities = NAMECHEAP_DNS_CAPABILITIES;
  readonly supportedRecordTypes = NAMECHEAP_RECORD_TYPES;

  constructor(
    readonly account: ProviderAccountRef,
    private readonly client: NamecheapClient,
  ) {}

  async readZone(ctx: AdapterCallContext, name: PublicDomainName): Promise<Zone> {
    const command = "namecheap.domains.dns.getHosts";
    const result = await this.client.call(ctx, command, { SLD: name.sld, TLD: name.suffix });
    try {
      const row = requireChild(result.response, "DomainDNSGetHostsResult");
      const records = children(row, "Host").map((host): ZoneRecord => {
        const type = requireAttr(host, "Type").toUpperCase();
        const ttlRaw = attr(host, "TTL");
        return {
          host: requireAttr(host, "Name"),
          type,
          value: requireAttr(host, "Address"),
          ttl: ttlRaw === undefined || ttlRaw === "" ? DEFAULT_TTL : parseIntStrict(ttlRaw, "TTL"),
          // getHosts prints MXPref on every record (`MXPref="10"` on an A
          // record in the documented example); it means something only for MX.
          priority: type === "MX" ? parseIntStrict(requireAttr(host, "MXPref"), "MXPref") : null,
        };
      });
      const settings: Record<string, string> = {};
      // `EmailType` is not in getHosts' documented response table but setHosts
      // requires it; when the provider returns it, it is carried verbatim.
      const emailType = attr(row, EMAIL_TYPE_SETTING);
      if (emailType !== undefined && emailType !== "") settings[EMAIL_TYPE_SETTING] = emailType;
      const served = optionalBool(row, "IsUsingOurDNS");
      if (served === null) throw new XmlRejected("shape", "missing IsUsingOurDNS");
      return { records, settings, servedByProvider: served };
    } catch (err) {
      if (err instanceof XmlRejected) throw this.client.shapeError(command, err.message);
      throw err;
    }
  }

  async replaceZone(ctx: AdapterCallContext, name: PublicDomainName, zone: Zone): Promise<void> {
    // setHosts writes Namecheap's BasicDNS. When the domain delegates elsewhere
    // the write would "succeed" into a zone nobody resolves, and the API FAQ
    // says FreeDNS/PremiumDNS zones cannot be managed through the API at all.
    if (!zone.servedByProvider) {
      throw new ProviderError("unsupported", `namecheap: ${name.ascii} is not served by Namecheap BasicDNS`, {
        safeMessage: "This domain's DNS is not hosted by the registrar, so it cannot be edited here.",
      });
    }
    const params = buildSetHostsParams(name, zone);
    const command = "namecheap.domains.dns.setHosts";
    const result = await this.client.call(ctx, command, params);
    try {
      const row = requireChild(result.response, "DomainDNSSetHostsResult");
      const success = optionalBool(row, "IsSuccess");
      if (success !== true) throw new XmlRejected("shape", "IsSuccess is not true");
    } catch (err) {
      if (err instanceof XmlRejected) throw this.client.shapeError(command, err.message);
      throw err;
    }
  }
}

function invalid(detail: string): ProviderError {
  return new ProviderError("validation", `namecheap setHosts: ${detail}`);
}

/** Serialize a complete zone, refusing anything that could not be written back faithfully. */
export function buildSetHostsParams(name: PublicDomainName, zone: Zone): Record<string, string> {
  // Sending an empty host set deletes every record. The documentation marks
  // HostName[1..n] as required, and an empty desired zone is far more likely
  // to be a bug upstream than an intent; it is refused.
  if (zone.records.length === 0) throw invalid("refusing to replace a zone with no records");

  const settingKeys = Object.keys(zone.settings);
  const unknown = settingKeys.filter((key) => key !== EMAIL_TYPE_SETTING);
  if (unknown.length > 0) {
    // A setting this adapter cannot send is a setting a replace would reset.
    throw invalid(`cannot preserve zone settings ${unknown.join(", ")}`);
  }
  const emailType = zone.settings[EMAIL_TYPE_SETTING];
  // Documented as required. Omitting it risks resetting mail routing, so a
  // zone read without one is not written.
  if (emailType === undefined || !/^[A-Za-z]{1,16}$/.test(emailType)) {
    throw invalid("EmailType is missing; read the zone before replacing it");
  }

  const params: Record<string, string> = {
    SLD: name.sld,
    TLD: name.suffix,
    EmailType: emailType,
  };
  zone.records.forEach((record, index) => {
    const n = index + 1;
    const type = record.type.toUpperCase();
    if (!NAMECHEAP_RECORD_TYPES.includes(type)) throw invalid(`record ${n}: type ${record.type} is not supported`);
    if (!HOST_RE.test(record.host)) throw invalid(`record ${n}: invalid host`);
    if (record.value.length === 0 || /[\r\n\0]/.test(record.value)) throw invalid(`record ${n}: invalid value`);
    if (!Number.isInteger(record.ttl) || record.ttl < MIN_TTL || record.ttl > MAX_TTL) {
      throw invalid(`record ${n}: TTL must be ${MIN_TTL}–${MAX_TTL}`);
    }
    params[`HostName${n}`] = record.host;
    params[`RecordType${n}`] = type;
    params[`Address${n}`] = record.value;
    params[`TTL${n}`] = String(record.ttl);
    if (type === "MX") {
      if (record.priority === null || !Number.isInteger(record.priority) || record.priority < 0 || record.priority > 65535) {
        throw invalid(`record ${n}: MX needs a priority 0–65535`);
      }
      params[`MXPref${n}`] = String(record.priority);
    } else if (record.priority !== null) {
      throw invalid(`record ${n}: priority is only meaningful for MX`);
    }
  });
  return params;
}
