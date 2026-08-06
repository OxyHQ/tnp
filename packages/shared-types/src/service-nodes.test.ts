import { describe, expect, test } from "bun:test";
import {
  parseRegisterServiceNodeRequest,
  parseServiceNodeHeartbeatRequest,
} from "./service-nodes.js";

const DOMAIN_ID = "9f8d3b1c-2e4a-4d6b-8c7e-1a2b3c4d5e6f";

describe("parseRegisterServiceNodeRequest", () => {
  test("accepts the contract shape", () => {
    expect(
      parseRegisterServiceNodeRequest({ domainId: DOMAIN_ID, publicKey: "cHVibGljLWtleQ==" }),
    ).toEqual({
      ok: true,
      value: { domainId: DOMAIN_ID, publicKey: "cHVibGljLWtleQ==" },
    });
  });

  test("names the field for every rejection", () => {
    const cases: Array<[unknown, string]> = [
      [{ publicKey: "cHVibGljLWtleQ==" }, "domainId is required"],
      [
        { domainId: "not-a-uuid", publicKey: "cHVibGljLWtleQ==" },
        "domainId must be a uuid",
      ],
      [{ domainId: DOMAIN_ID }, "publicKey is required"],
      [{ domainId: DOMAIN_ID, publicKey: "   " }, "publicKey is required"],
      ["domainId", "request body must be an object"],
    ];

    for (const [body, error] of cases) {
      const parsed = parseRegisterServiceNodeRequest(body);
      expect(parsed.ok).toBe(false);
      expect(parsed.ok ? "" : parsed.error).toBe(error);
    }
  });
});

describe("parseServiceNodeHeartbeatRequest", () => {
  test("accepts the contract shape", () => {
    expect(
      parseServiceNodeHeartbeatRequest({
        domainId: DOMAIN_ID,
        connectedRelay: "wss://relay.example.test",
      }),
    ).toEqual({
      ok: true,
      value: { domainId: DOMAIN_ID, connectedRelay: "wss://relay.example.test" },
    });
  });

  test("requires the relay the node is attached to", () => {
    const parsed = parseServiceNodeHeartbeatRequest({ domainId: DOMAIN_ID });

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.error).toBe("connectedRelay is required");
  });
});
