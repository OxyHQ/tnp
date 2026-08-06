/**
 * `@types/dns-packet` omits `rcode`, which the library does populate when
 * decoding (`index.js` header.decode: `rcode: rcodes.toString(flags & 0xf)`).
 *
 * Declared here rather than worked around with a cast, so the response code is
 * a typed field everywhere it is read. Note the asymmetry the library actually
 * has, and which `wire.ts` depends on: `rcode` is produced on DECODE and
 * ignored on ENCODE — the header encoder reads only `flags`. It is therefore
 * declared read-only-in-practice and never set on a packet being encoded.
 */
declare module "dns-packet" {
  interface DecodedPacket {
    /** e.g. "NOERROR", "NXDOMAIN", "SERVFAIL". Populated on decode only. */
    rcode: string;
  }
}

export {};
