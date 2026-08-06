import { describe, expect, test } from "bun:test";
import dnsPacket from "dns-packet";
import {
  buildResponse,
  decodeQuery,
  encode,
  encodeForUdp,
  encodeRawError,
  ednsUdpSize,
  rcodeOf,
  RCODE,
} from "./wire";

function query(
  name: string,
  type: dnsPacket.RecordType = "A",
  opts: { rd?: boolean; ednsSize?: number; id?: number } = {},
): Buffer {
  const additionals: dnsPacket.Answer[] = [];
  if (opts.ednsSize !== undefined) {
    additionals.push({
      type: "OPT",
      name: ".",
      udpPayloadSize: opts.ednsSize,
      extendedRcode: 0,
      ednsVersion: 0,
      flags: 0,
      flag_do: false,
      options: [],
    });
  }
  return dnsPacket.encode({
    type: "query",
    id: opts.id ?? 0x1234,
    flags: opts.rd === false ? 0 : dnsPacket.RECURSION_DESIRED,
    questions: [{ type, name }],
    additionals,
  });
}

describe("response codes", () => {
  // The bug this whole module exists to prevent: the old resolver hardcoded
  // 0x8180 (NOERROR) into every response it built, so an upstream NXDOMAIN came
  // back as "this name exists and has no records of this type" (audit B3).
  test("every code round-trips through the wire", () => {
    for (const name of ["NOERROR", "FORMERR", "SERVFAIL", "NXDOMAIN", "NOTIMP", "REFUSED"] as const) {
      const response = decodeQuery(encode(buildResponse(decodeQuery(query("a.ox")), { rcode: name })));
      expect(rcodeOf(response)).toBe(RCODE[name]);
      expect(response.rcode).toBe(name);
    }
  });

  test("NXDOMAIN is distinguishable from an empty NOERROR", () => {
    const q = decodeQuery(query("a.ox"));
    const missing = decodeQuery(encode(buildResponse(q, { rcode: "NXDOMAIN" })));
    const empty = decodeQuery(encode(buildResponse(q, { rcode: "NOERROR" })));

    expect(missing.answers).toHaveLength(0);
    expect(empty.answers).toHaveLength(0);
    expect(rcodeOf(missing)).not.toBe(rcodeOf(empty));
  });

  test("setting the dns-packet `rcode` field alone does NOT work", () => {
    // Guards the assumption the whole RCODE table rests on. dns-packet's header
    // encoder reads only `flags`; if a future version starts honouring `rcode`,
    // this test flips and the comment in wire.ts needs revisiting.
    // `rcode` is a decode-only field (see dns-packet.d.ts), so it is set here
    // through a packet shape that carries it, exactly as a caller might expect
    // to be able to.
    const withRcodeField: dnsPacket.Packet & { rcode: string } = {
      type: "response",
      id: 1,
      rcode: "NXDOMAIN",
      questions: [{ type: "A", name: "a.ox" }],
    };
    expect(dnsPacket.decode(dnsPacket.encode(withRcodeField)).rcode).toBe("NOERROR");
  });
});

describe("header flags", () => {
  test("mirrors RD and always sets RA", () => {
    const withRd = decodeQuery(encode(buildResponse(decodeQuery(query("a.ox")), { rcode: "NOERROR" })));
    expect(withRd.flag_rd).toBe(true);
    expect(withRd.flag_ra).toBe(true);

    const noRd = decodeQuery(
      encode(buildResponse(decodeQuery(query("a.ox", "A", { rd: false })), { rcode: "NOERROR" })),
    );
    expect(noRd.flag_rd).toBe(false);
    expect(noRd.flag_ra).toBe(true);
  });

  test("sets AA only for authoritative answers", () => {
    const q = decodeQuery(query("a.ox"));
    expect(decodeQuery(encode(buildResponse(q, { rcode: "NOERROR", authoritative: true }))).flag_aa).toBe(true);
    expect(decodeQuery(encode(buildResponse(q, { rcode: "NOERROR" }))).flag_aa).toBe(false);
  });

  test("echoes the query id and question", () => {
    const response = decodeQuery(
      encode(buildResponse(decodeQuery(query("a.b.ox", "MX", { id: 0xbeef })), { rcode: "NOERROR" })),
    );
    expect(response.id).toBe(0xbeef);
    expect(response.questions?.[0]).toMatchObject({ name: "a.b.ox", type: "MX" });
  });
});

describe("RDATA encoding", () => {
  // The old encoder wrote RDLENGTH 0 for everything that was not an A record,
  // and raw UTF-8 for TXT/MX/NS — structurally valid, semantically wrong.
  test("each record type survives a round trip intact", () => {
    const answers: dnsPacket.Answer[] = [
      { type: "A", name: "e.ox", ttl: 300, data: "203.0.113.10" },
      { type: "AAAA", name: "e.ox", ttl: 300, data: "2001:db8::1" },
      { type: "CNAME", name: "w.e.ox", ttl: 300, data: "e.ox" },
      { type: "NS", name: "e.ox", ttl: 300, data: "ns1.e.ox" },
      { type: "MX", name: "e.ox", ttl: 300, data: { preference: 20, exchange: "mail.e.ox" } },
      { type: "TXT", name: "e.ox", ttl: 300, data: "v=spf1 -all" },
    ];

    const decoded = decodeQuery(
      encode(buildResponse(decodeQuery(query("e.ox", "TXT")), { rcode: "NOERROR", answers })),
    );

    expect(decoded.answers).toHaveLength(6);
    const byType = new Map(decoded.answers?.map((a) => [a.type, a]));

    expect(byType.get("A")).toMatchObject({ data: "203.0.113.10", ttl: 300 });
    expect(byType.get("AAAA")).toMatchObject({ data: "2001:db8::1" });
    expect(byType.get("CNAME")).toMatchObject({ data: "e.ox" });
    expect(byType.get("NS")).toMatchObject({ data: "ns1.e.ox" });
    expect(byType.get("MX")).toMatchObject({ data: { preference: 20, exchange: "mail.e.ox" } });

    // TXT decodes as a Buffer array; a zero-length RDATA would be the old bug.
    const txt = byType.get("TXT");
    expect(txt?.type).toBe("TXT");
    if (txt?.type === "TXT") {
      expect(Buffer.concat([txt.data].flat().map(Buffer.from)).toString()).toBe("v=spf1 -all");
    }
  });

  test("a record's RDATA is never empty", () => {
    // Directly targets the `RDLENGTH 0` failure: assert every answer carries
    // bytes, so a silently dropped payload cannot pass as a valid record.
    const answers: dnsPacket.Answer[] = [
      { type: "MX", name: "e.ox", ttl: 60, data: { preference: 10, exchange: "m.e.ox" } },
      { type: "TXT", name: "e.ox", ttl: 60, data: "x" },
      { type: "NS", name: "e.ox", ttl: 60, data: "n.e.ox" },
    ];
    const decoded = decodeQuery(
      encode(buildResponse(decodeQuery(query("e.ox", "TXT")), { rcode: "NOERROR", answers })),
    );
    for (const answer of decoded.answers ?? []) {
      if (answer.type === "OPT") continue;
      expect(JSON.stringify(answer.data).length).toBeGreaterThan(2);
    }
  });
});

describe("EDNS(0)", () => {
  test("reports the advertised buffer size, clamped", () => {
    expect(ednsUdpSize(decodeQuery(query("a.ox", "A", { ednsSize: 1232 })))).toBe(1232);
    expect(ednsUdpSize(decodeQuery(query("a.ox", "A", { ednsSize: 100 })))).toBe(512);
    expect(ednsUdpSize(decodeQuery(query("a.ox", "A", { ednsSize: 65535 })))).toBe(4096);
  });

  test("is null when the query carries no OPT record", () => {
    expect(ednsUdpSize(decodeQuery(query("a.ox")))).toBeNull();
  });

  test("echoes an OPT record back so the client is not downgraded to 512", () => {
    const response = decodeQuery(
      encode(buildResponse(decodeQuery(query("a.ox", "A", { ednsSize: 1232 })), { rcode: "NOERROR" })),
    );
    const opt = response.additionals?.find((r) => r.type === "OPT");
    expect(opt).toBeDefined();
    if (opt?.type === "OPT") {
      expect(opt.udpPayloadSize).toBe(1232);
      // DO must stay clear: DNSSEC validation is not implemented, and setting
      // it would invite the client to trust an unvalidated answer.
      expect(opt.flag_do).toBe(false);
    }
  });
});

describe("truncation", () => {
  // Sized to sit BETWEEN the two limits on purpose: above 512 so the plain-UDP
  // case truncates, below 4096 so the EDNS case does not. A fixture on one side
  // of both limits could not tell the two behaviours apart.
  const manyAnswers: dnsPacket.Answer[] = Array.from({ length: 40 }, (_, i) => ({
    type: "TXT" as const,
    name: "big.ox",
    ttl: 300,
    data: `record-${i}-${"x".repeat(40)}`,
  }));

  test("the fixture straddles both UDP limits", () => {
    const q = decodeQuery(query("big.ox", "TXT", { ednsSize: 4096 }));
    const size = encode(buildResponse(q, { rcode: "NOERROR", answers: manyAnswers })).byteLength;
    expect(size).toBeGreaterThan(512);
    expect(size).toBeLessThanOrEqual(4096);
  });

  test("sets TC and drops the body when the response exceeds the UDP budget", () => {
    const q = decodeQuery(query("big.ox", "TXT"));
    const packet = buildResponse(q, { rcode: "NOERROR", answers: manyAnswers });

    expect(encode(packet).byteLength).toBeGreaterThan(512);

    const udp = encodeForUdp(q, packet);
    expect(udp.byteLength).toBeLessThanOrEqual(512);

    const decoded = decodeQuery(udp);
    expect(decoded.flag_tc).toBe(true);
    expect(decoded.answers).toHaveLength(0);
    // The rcode must survive truncation, or the client retries for nothing.
    expect(rcodeOf(decoded)).toBe(RCODE.NOERROR);
  });

  test("does not truncate when EDNS advertises enough room", () => {
    const q = decodeQuery(query("big.ox", "TXT", { ednsSize: 4096 }));
    const udp = encodeForUdp(q, buildResponse(q, { rcode: "NOERROR", answers: manyAnswers }));
    const decoded = decodeQuery(udp);

    expect(decoded.flag_tc).toBe(false);
    expect(decoded.answers).toHaveLength(40);
  });

  test("leaves a small response alone", () => {
    const q = decodeQuery(query("a.ox"));
    const decoded = decodeQuery(
      encodeForUdp(q, buildResponse(q, { rcode: "NOERROR", answers: [{ type: "A", name: "a.ox", ttl: 60, data: "1.2.3.4" }] })),
    );
    expect(decoded.flag_tc).toBe(false);
    expect(decoded.answers).toHaveLength(1);
  });
});

describe("encodeRawError", () => {
  test("replies to an undecodable query using the raw header", () => {
    // A client that gets no reply waits for its full timeout; a FORMERR it can
    // match by id fails immediately.
    const truncatedQuery = query("a.ox").subarray(0, 14);
    const response = encodeRawError(Buffer.from(truncatedQuery), "FORMERR");

    expect(response).not.toBeNull();
    if (response) {
      const decoded = decodeQuery(response);
      expect(decoded.id).toBe(0x1234);
      expect(rcodeOf(decoded)).toBe(RCODE.FORMERR);
      expect(decoded.flag_qr).toBe(true);
    }
  });

  test("returns null when there is not even a header to answer", () => {
    expect(encodeRawError(Buffer.alloc(4), "FORMERR")).toBeNull();
  });
});
