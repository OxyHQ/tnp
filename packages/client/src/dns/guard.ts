/**
 * Pre-decode validation of incoming queries, and the limits that bound what a
 * query can cost or make us send.
 *
 * Everything here reads raw header bytes. `dns-packet` will happily decode a
 * 64 KB message whose names are long chains of compression pointers, which
 * costs hundreds of milliseconds per packet — so the resolver must decide
 * whether a packet is a plausible query BEFORE handing it to the decoder, not
 * after. A legitimate stub query is one question, no answer or authority
 * records, and at most an EDNS(0) OPT record: a few dozen bytes whose structure
 * can be walked in a single bounded pass.
 */

import type { RcodeName } from './wire';

/** Largest query accepted from a client that did not advertise EDNS(0). */
export const MAX_QUERY_BYTES_PLAIN = 512;

/**
 * Hard ceiling on any query, and on any UDP response we send.
 *
 * 1232 is the DNS Flag Day 2020 figure: the largest payload that fits a 1280
 * byte IPv6 minimum MTU without fragmentation. Capping responses here (instead
 * of honouring a client's 4096) bounds the amplification an open resolver
 * offers a spoofed source, and avoids IP fragmentation, which is itself a
 * cache-poisoning vector.
 */
export const MAX_UDP_PAYLOAD = 1232;

const TYPE_OPT = 41;
const CLASS_IN = 1;
const CLASS_ANY = 255;
const TYPE_IXFR = 251;
const TYPE_AXFR = 252;

const FLAG_QR = 0x8000;
const FLAG_RD = 0x0100;
const FLAG_TC = 0x0200;
const FLAG_RA = 0x0080;

export type QueryVerdict =
  /** Structurally a single-question query. Safe to decode. */
  | { kind: 'ok'; questionEnd: number; ednsSize: number | null }
  /** Not worth any reply: too short, too large, or not a query at all. */
  | { kind: 'drop'; reason: string }
  /** Reply with a header-only error; never decode the packet. */
  | { kind: 'error'; rcode: RcodeName; reason: string };

/**
 * Decide what to do with an incoming packet from its raw bytes alone.
 *
 * - Responses (QR=1) are dropped, never answered: answering a response is how
 *   two resolvers end up reflecting packets at each other forever.
 * - Opcodes other than QUERY get NOTIMP.
 * - Anything other than exactly one question, no answers, no authority and at
 *   most one OPT record is FORMERR.
 * - The question name is walked label by label; a compression pointer in a
 *   query's only name can only point backwards into the header, so it is
 *   refused rather than followed.
 * - Over UDP, a query larger than 512 bytes is dropped unless it carries an
 *   OPT record advertising at least that size (capped at 1232).
 */
export function inspectQuery(buf: Buffer, transport: 'udp' | 'tcp'): QueryVerdict {
  if (buf.byteLength < 12) return { kind: 'drop', reason: 'shorter than a DNS header' };
  if (buf.byteLength > MAX_UDP_PAYLOAD) return { kind: 'drop', reason: 'oversized query' };

  const flags = buf.readUInt16BE(2);
  if ((flags & FLAG_QR) !== 0) return { kind: 'drop', reason: 'not a query (QR=1)' };

  const opcode = (flags >> 11) & 0xf;
  if (opcode !== 0) return { kind: 'error', rcode: 'NOTIMP', reason: `opcode ${opcode}` };

  const qdcount = buf.readUInt16BE(4);
  const ancount = buf.readUInt16BE(6);
  const nscount = buf.readUInt16BE(8);
  const arcount = buf.readUInt16BE(10);
  if (qdcount !== 1 || ancount !== 0 || nscount !== 0 || arcount > 1) {
    return { kind: 'error', rcode: 'FORMERR', reason: 'section counts' };
  }

  // Question name: plain labels only, at most 255 octets on the wire.
  let offset = 12;
  let nameLength = 0;
  for (;;) {
    if (offset >= buf.byteLength) {
      return { kind: 'error', rcode: 'FORMERR', reason: 'truncated name' };
    }
    const len = buf[offset];
    if ((len & 0xc0) !== 0) {
      return { kind: 'error', rcode: 'FORMERR', reason: 'pointer in question' };
    }
    nameLength += len + 1;
    if (nameLength > 255) return { kind: 'error', rcode: 'FORMERR', reason: 'name too long' };
    offset += 1 + len;
    if (len === 0) break;
  }

  if (offset + 4 > buf.byteLength) {
    return { kind: 'error', rcode: 'FORMERR', reason: 'truncated question' };
  }
  const qtype = buf.readUInt16BE(offset);
  const qclass = buf.readUInt16BE(offset + 2);
  offset += 4;
  const questionEnd = offset;

  if (qtype === TYPE_OPT) return { kind: 'error', rcode: 'FORMERR', reason: 'OPT as question' };
  if (qtype === TYPE_AXFR || qtype === TYPE_IXFR) {
    return { kind: 'error', rcode: 'REFUSED', reason: 'zone transfer' };
  }
  if (qclass !== CLASS_IN && qclass !== CLASS_ANY) {
    return { kind: 'error', rcode: 'REFUSED', reason: `class ${qclass}` };
  }

  let ednsSize: number | null = null;
  if (arcount === 1) {
    // The only additional record a stub legitimately sends is EDNS(0): owner
    // is the root (one zero byte), type OPT, then CLASS=payload size, TTL,
    // RDLENGTH and RDATA, ending exactly at the end of the packet.
    if (offset + 11 > buf.byteLength || buf[offset] !== 0) {
      return { kind: 'error', rcode: 'FORMERR', reason: 'malformed additional' };
    }
    if (buf.readUInt16BE(offset + 1) !== TYPE_OPT) {
      return { kind: 'error', rcode: 'FORMERR', reason: 'additional is not OPT' };
    }
    ednsSize = buf.readUInt16BE(offset + 3);
    const rdlength = buf.readUInt16BE(offset + 9);
    offset += 11 + rdlength;
  }

  if (offset !== buf.byteLength) {
    return { kind: 'error', rcode: 'FORMERR', reason: 'trailing bytes' };
  }

  if (transport === 'udp' && buf.byteLength > MAX_QUERY_BYTES_PLAIN) {
    const allowed =
      ednsSize === null
        ? MAX_QUERY_BYTES_PLAIN
        : Math.min(Math.max(ednsSize, 512), MAX_UDP_PAYLOAD);
    if (buf.byteLength > allowed) return { kind: 'drop', reason: 'larger than advertised' };
  }

  return { kind: 'ok', questionEnd, ednsSize };
}

/**
 * A header-plus-question response with TC set, built from raw bytes.
 *
 * Used when a source is over its rate limit: instead of answering, every other
 * query gets this "retry over TCP" reply. It is never larger than the query
 * that triggered it, so it offers a spoofer no amplification, while a real
 * client behind a busy NAT still gets its answer over TCP — which a spoofed
 * source cannot complete.
 */
export function encodeTruncated(queryBuf: Buffer, questionEnd: number): Buffer {
  const out = Buffer.alloc(questionEnd);
  queryBuf.copy(out, 0, 0, questionEnd);
  const rd = queryBuf.readUInt16BE(2) & FLAG_RD;
  out.writeUInt16BE(FLAG_QR | FLAG_TC | FLAG_RA | rd, 2);
  out.writeUInt16BE(1, 4);
  out.writeUInt16BE(0, 6);
  out.writeUInt16BE(0, 8);
  out.writeUInt16BE(0, 10);
  return out;
}

/**
 * The raw question section (name, type, class) of a message, or null when it
 * is not exactly one plainly-encoded question.
 *
 * Used to check that an upstream answer is an answer to the question we
 * asked. The name is lowercased so a resolver that echoes the question in a
 * different case (DNS 0x20) still matches.
 */
export function questionOf(buf: Buffer): Buffer | null {
  if (buf.byteLength < 12 || buf.readUInt16BE(4) !== 1) return null;
  let offset = 12;
  for (;;) {
    if (offset >= buf.byteLength) return null;
    const len = buf[offset];
    if ((len & 0xc0) !== 0 || len > 63) return null;
    offset += 1 + len;
    if (len === 0) break;
  }
  if (offset + 4 > buf.byteLength) return null;
  const question = Buffer.from(buf.subarray(12, offset + 4));
  for (let i = 0; i < question.byteLength - 4; i++) {
    const c = question[i];
    if (c >= 0x41 && c <= 0x5a) question[i] = c | 0x20;
  }
  return question;
}
