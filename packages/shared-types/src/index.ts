export { type ParseResult } from "./parse.js";

export {
  normalizeRelayEndpoint,
  parseRegisterRelayRequest,
  parseRelayHeartbeatRequest,
  MAX_RELAY_BANDWIDTH_MBPS,
  MAX_RELAY_CONNECTIONS,
  type RegisterRelayRequest,
  type RelayCapacity,
  type RelayDirectoryEntry,
  type RelayHeartbeatRequest,
  type RelayHeartbeatResponse,
  type RelayOperator,
  type RelayRegistration,
  type RelayStatus,
} from "./relays.js";

export {
  parseRegisterServiceNodeRequest,
  parseServiceNodeHeartbeatRequest,
  type RegisterServiceNodeRequest,
  type ServiceNodeHeartbeatRequest,
  type ServiceNodeHeartbeatResponse,
  type ServiceNodeLookup,
  type ServiceNodeRegistration,
  type ServiceNodeStatus,
} from "./service-nodes.js";

export {
  isDnsRecordType,
  isValidIpv4,
  isValidIpv6,
  mergeDnsRecordUpdate,
  normalizeHostname,
  parseCreateDnsRecordRequest,
  parseUpdateDnsRecordRequest,
  splitMxValue,
  DNS_RECORD_TTL_DEFAULT,
  DNS_RECORD_TTL_MAX,
  DNS_RECORD_TTL_MIN,
  DNS_RECORD_TYPES,
  DNS_TXT_MAX_LENGTH,
  MAX_DNS_RECORDS_PER_DOMAIN,
  type CreateDnsRecordRequest,
  type DnsRecordDto,
  type DnsRecordErrorCode,
  type DnsRecordField,
  type DnsRecordInput,
  type DnsRecordParseError,
  type DnsRecordParseResult,
  type DnsRecordType,
  type UpdateDnsRecordRequest,
} from "./dns-records.js";

export {
  type DomainStatus,
  type NativeAvailability,
  type NativeAvailabilityReason,
  type NativeExpiryStateDto,
  type OwnedDomain,
  type OwnedDomainPage,
  type OwnedDomainSummary,
  type OwnedDomainWithRecords,
  type PublicDomain,
  type PublicDomainPage,
  type PublicDomainWithRecords,
  type PublicTld,
  type RenewDomainResponse,
  type TldProposalEntry,
} from "./domains.js";

export {
  type DnsResolveAnswer,
  type DnsResolveOverlay,
  type DnsResolveRcode,
  type DnsResolveResponse,
} from "./dns-resolve.js";
