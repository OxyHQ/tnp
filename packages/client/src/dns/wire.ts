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

import dnsPacket, { type Answer, type DecodedPacket, type Packet, type Question } from 'dns-packet';
import { MAX_UDP_PAYLOAD } from './guard';

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

const {
  AUTHENTIC_DATA,
  AUTHORITATIVE_ANSWER,
  RECURSION_DESIRED,
  RECURSION_AVAILABLE,
  TRUNCATED_RESPONSE,
} = dnsPacket;

/**
 * Largest response we will send over UDP without EDNS(0).
 *
 * RFC 1035 §4.2.1. A client that advertises a larger buffer via EDNS gets it;
 * anything above the applicable limit is truncated with TC set so the client
 * retries over TCP.
 */
export const DNS_UDP_SIZE_LIMIT = 512;

/**
 * Largest EDNS(0) buffer we will honour. A client advertising 4096 still gets
 * at most 1232 bytes over UDP: see `MAX_UDP_PAYLOAD` in `guard.ts`.
 */
export const EDNS_MAX_UDP_SIZE = MAX_UDP_PAYLOAD;

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
  const opt = query.additionals?.find((record) => record.type === 'OPT');
  if (opt?.type !== 'OPT') return null;
  return Math.min(Math.max(opt.udpPayloadSize, DNS_UDP_SIZE_LIMIT), EDNS_MAX_UDP_SIZE);
}

export interface ResponseInit {
  rcode: RcodeName;
  answers?: Packet['answers'];
  authorities?: Packet['authorities'];
  additionals?: Packet['additionals'];
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
  if (advertised !== null && !additionals.some((record) => record.type === 'OPT')) {
    additionals.push({
      type: 'OPT',
      name: '.',
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
    type: 'response',
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
    type: 'response',
    id,
    flags: RECURSION_AVAILABLE | (rd ? RECURSION_DESIRED : 0) | RCODE[rcode],
    questions: [],
    answers: [],
    authorities: [],
    additionals: [],
  });
}

/** Pad DoH queries to a multiple of this many bytes (RFC 8467 §4.1). */
const QUERY_PADDING_BLOCK = 128;

/**
 * The query we actually send upstream for a client's public-DNS question.
 *
 * Rebuilt from the decoded question rather than forwarded byte for byte, so
 * nothing the client put in its packet travels further than it has to:
 *
 * - **RD is the client's**; nothing else from its header is copied.
 * - **DO and CD are cleared and AD is not asked for.** This resolver does not
 *   validate DNSSEC. Forwarding DO would fetch signatures we never check (and
 *   bigger answers to amplify with); passing an upstream's AD bit on would let
 *   a client believe an answer was validated by us.
 * - **Every EDNS option is dropped.** A client's EDNS Client Subnet, cookie or
 *   device-ID option is identifying, and none of them is ours to forward.
 * - **DoH queries are padded** to a 128-byte block (RFC 8467), so the size of
 *   the encrypted request does not reveal the length of the name.
 * - **The advertised buffer is 1232.** Besides avoiding fragmentation, this
 *   keeps classic upstream answers inside what Bun's `node:dgram` can receive:
 *   verified on Bun 1.4.3, a datagram over ~1500 bytes is silently never
 *   delivered, so an upstream told 4096 could answer into the void. Above
 *   1232 a compliant upstream sets TC and the TCP retry fetches the answer.
 */
export function upstreamQuery(query: DecodedPacket, options: { pad: boolean }): Buffer {
  const question = query.questions?.[0];
  if (!question) throw new Error('query has no question');

  const build = (padding: number): Buffer =>
    dnsPacket.encode({
      type: 'query',
      id: query.id ?? 0,
      // Mirror the client's RD: a non-recursive query stays non-recursive.
      flags: query.flag_rd ? RECURSION_DESIRED : 0,
      questions: [{ name: question.name, type: question.type, class: question.class }],
      additionals: [
        {
          type: 'OPT',
          name: '.',
          udpPayloadSize: MAX_UDP_PAYLOAD,
          extendedRcode: 0,
          ednsVersion: 0,
          flags: 0,
          flag_do: false,
          options: padding > 0 ? [{ code: 12, length: padding - 4 }] : [],
        },
      ],
    });

  const plain = build(0);
  if (!options.pad) return plain;
  // A padding option costs four bytes of header before its own zeros.
  let padding = QUERY_PADDING_BLOCK - (plain.byteLength % QUERY_PADDING_BLOCK);
  if (padding < 4) padding += QUERY_PADDING_BLOCK;
  return build(padding);
}

/**
 * Clear the AD bit on an upstream response we are relaying.
 *
 * AD means "the resolver you asked validated this". We did not, so we must
 * not pass it on.
 */
export function clearAuthenticData(response: Buffer): Buffer {
  if (response.byteLength < 4) return response;
  const out = Buffer.from(response);
  out.writeUInt16BE(out.readUInt16BE(2) & ~AUTHENTIC_DATA, 2);
  return out;
}

/**
 * Fit an already-encoded upstream response into the client's UDP budget.
 *
 * Within budget it passes through untouched, so RDATA we do not model is never
 * re-encoded. Over budget, the reply becomes header plus question with TC set
 * and the upstream response code kept, and the client retries over TCP.
 */
export function capEncodedForUdp(query: DecodedPacket, response: Buffer): Buffer {
  const limit = ednsUdpSize(query) ?? DNS_UDP_SIZE_LIMIT;
  if (response.byteLength <= limit) return response;

  const upstreamFlags = response.byteLength >= 4 ? response.readUInt16BE(2) : RECURSION_AVAILABLE;
  return dnsPacket.encode({
    type: 'response',
    id: query.id,
    flags: (upstreamFlags & ~AUTHENTIC_DATA) | TRUNCATED_RESPONSE,
    questions: query.questions ?? [],
    answers: [],
    authorities: [],
    additionals: [],
  });
}
