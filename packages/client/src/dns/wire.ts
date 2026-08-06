/**
 * DNS wire format.
 *
 * Encoding and decoding go through `dns-packet`, which implements name
 * compression, EDNS(0) and the RDATA layout of every type TNP serves. The
 * resolver previously hand-built responses field by field and got several of
 * them wrong: the response code was hardcoded to NOERROR so an upstream
 * NXDOMAIN was lost, and TXT/MX/NS/SRV/CAA RDATA was written as a raw UTF-8
 * blob rather than in its defined encoding (audit B3).
 *
 * The one thing `dns-packet` does NOT do for you is response codes on the way
 * out — see `RCODE` below.
 */

import dnsPacket, {
  type Answer,
  type DecodedPacket,
  type Packet,
  type Question,
} from "dns-packet";

/**
 * Response codes, as the low four bits of the header flags.
 *
 * `dns-packet` exposes `rcode` as a string when DECODING, but its header
 * encoder reads only `flags` — passing `{ rcode: "NXDOMAIN" }` to `encode()`
 * is silently ignored and produces NOERROR. Verified against dns-packet 5.6.1:
 * the rcode field round-tripped as NOERROR, and only `flags | 3` produced
 * NXDOMAIN. Every response therefore sets its code here, in the flags.
 */
export const RCODE = {
  NOERROR: 0,
  FORMERR: 1,
  SERVFAIL: 2,
  NXDOMAIN: 3,
  NOTIMP: 4,
  REFUSED: 5,
} as const;

export type RcodeName = keyof typeof RCODE;

/** Mask covering the response-code bits. */
const RCODE_MASK = 0x000f;

const { AUTHORITATIVE_ANSWER, RECURSION_DESIRED, RECURSION_AVAILABLE, TRUNCATED_RESPONSE } =
  dnsPacket;

/**
 * Largest response we will send over UDP without EDNS(0).
 *
 * RFC 1035 §4.2.1. A client that advertises a larger buffer via EDNS gets it;
 * anything above the applicable limit is truncated with TC set so the client
 * retries over TCP.
 */
export const DNS_UDP_SIZE_LIMIT = 512;

/** Largest EDNS(0) buffer we will honour, to bound the memory a query can cost. */
export const EDNS_MAX_UDP_SIZE = 4096;

export type { Answer, DecodedPacket, Packet, Question };

export function decodeQuery(buf: Buffer): DecodedPacket {
  return dnsPacket.decode(buf);
}

/** The response code of a decoded packet, as a number. */
export function rcodeOf(packet: DecodedPacket): number {
  return (packet.flags ?? 0) & RCODE_MASK;
}

/**
 * The EDNS(0) UDP buffer size the client advertised, clamped to our ceiling.
 * Returns null when the query carries no OPT record, meaning plain 512 applies.
 */
export function ednsUdpSize(query: DecodedPacket): number | null {
  const opt = query.additionals?.find((record) => record.type === "OPT");
  if (!opt || opt.type !== "OPT") return null;
  return Math.min(Math.max(opt.udpPayloadSize, DNS_UDP_SIZE_LIMIT), EDNS_MAX_UDP_SIZE);
}

export interface ResponseInit {
  rcode: RcodeName;
  answers?: Packet["answers"];
  authorities?: Packet["authorities"];
  additionals?: Packet["additionals"];
  /** Set when TNP is the authority for the name, i.e. TNP-native answers. */
  authoritative?: boolean;
}

/**
 * Build a response to `query`.
 *
 * Copies the question section back, mirrors RD, and always sets RA — the
 * resolver does recurse on the client's behalf. An EDNS(0) OPT record is echoed
 * when the client sent one, since dropping it downgrades the client to 512-byte
 * UDP for no reason.
 */
export function buildResponse(query: DecodedPacket, init: ResponseInit): Packet {
  let flags = RECURSION_AVAILABLE | RCODE[init.rcode];
  if (query.flag_rd) flags |= RECURSION_DESIRED;
  if (init.authoritative) flags |= AUTHORITATIVE_ANSWER;

  const additionals = [...(init.additionals ?? [])];
  const advertised = ednsUdpSize(query);
  if (advertised !== null && !additionals.some((record) => record.type === "OPT")) {
    additionals.push({
      type: "OPT",
      name: ".",
      udpPayloadSize: advertised,
      // EDNS(0) only. The extended rcode stays zero because every code this
      // resolver produces fits the four header bits; DO is off because DNSSEC
      // validation is not implemented, and claiming otherwise would invite a
      // client to trust an unvalidated answer.
      extendedRcode: 0,
      ednsVersion: 0,
      flags: 0,
      flag_do: false,
      options: [],
    });
  }

  return {
    type: "response",
    id: query.id,
    flags,
    questions: query.questions ?? [],
    answers: init.answers ?? [],
    authorities: init.authorities ?? [],
    additionals,
  };
}

export function encode(packet: Packet): Buffer {
  return dnsPacket.encode(packet);
}

/**
 * Encode a response for UDP, truncating with TC set when it does not fit.
 *
 * A response that overflows and is sent anyway is silently clipped by the
 * network stack or dropped; setting TC is what tells the client to retry over
 * TCP. The old resolver never set it.
 */
export function encodeForUdp(query: DecodedPacket, packet: Packet): Buffer {
  const limit = ednsUdpSize(query) ?? DNS_UDP_SIZE_LIMIT;
  const full = dnsPacket.encode(packet);
  if (full.byteLength <= limit) return full;

  return dnsPacket.encode({
    ...packet,
    flags: (packet.flags ?? 0) | TRUNCATED_RESPONSE,
    answers: [],
    authorities: [],
    additionals: [],
  });
}

/**
 * Build a bare error response for a query we could not even parse.
 *
 * Takes the raw bytes because a malformed query may not decode at all; the ID
 * and the RD bit are read directly from the header so the client can match the
 * reply to its question instead of timing out.
 */
export function encodeRawError(queryBuf: Buffer, rcode: RcodeName): Buffer | null {
  if (queryBuf.byteLength < 12) return null;

  const id = queryBuf.readUInt16BE(0);
  const rd = (queryBuf.readUInt16BE(2) >> 8) & 0x1;

  return dnsPacket.encode({
    type: "response",
    id,
    flags: RECURSION_AVAILABLE | (rd ? RECURSION_DESIRED : 0) | RCODE[rcode],
    questions: [],
    answers: [],
    authorities: [],
    additionals: [],
  });
}
