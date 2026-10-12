import { describe, expect, test } from 'bun:test';
import { makeTestCredentials } from '@tnp/crypto/testing';
import {
  parseRegisterServiceNodeRequest,
  parseServiceNodeHeartbeatRequest,
} from './service-nodes.js';

const DOMAIN_ID = '9f8d3b1c-2e4a-4d6b-8c7e-1a2b3c4d5e6f';

describe('parseRegisterServiceNodeRequest', () => {
  const creds = makeTestCredentials('example.ox');

  test('accepts the contract shape', () => {
    const request = { domainId: DOMAIN_ID, chain: creds.chain, kaCert: creds.kaCert };
    expect(parseRegisterServiceNodeRequest(request)).toEqual({ ok: true, value: request });
  });

  test('names the field for every rejection', () => {
    const good = { domainId: DOMAIN_ID, chain: creds.chain, kaCert: creds.kaCert };
    const cases: Array<[unknown, string]> = [
      [{ ...good, domainId: undefined }, 'domainId is required'],
      [{ ...good, domainId: 'not-a-uuid' }, 'domainId must be a uuid'],
      [{ ...good, chain: [] }, 'chain must be an array of 1 to 4 grants'],
      [{ ...good, chain: [{ ...creds.chain[0], extra: 1 }] }, 'chain[0] has an unexpected field'],
      [{ ...good, kaCert: undefined }, 'kaCert must be an object'],
      [{ ...good, kaCert: { ...creds.kaCert, role: 'exit' } }, 'kaCert role is unknown'],
      // The pre-v1 body: a bare, unsigned X25519 key.
      [
        { domainId: DOMAIN_ID, publicKey: 'cHVibGljLWtleQ==' },
        'chain must be an array of 1 to 4 grants',
      ],
      ['domainId', 'request body must be an object'],
    ];

    for (const [body, error] of cases) {
      const parsed = parseRegisterServiceNodeRequest(body);
      expect(parsed.ok).toBe(false);
      expect(parsed.ok ? '' : parsed.error).toBe(error);
    }
  });
});

describe('parseServiceNodeHeartbeatRequest', () => {
  test('accepts the contract shape', () => {
    expect(
      parseServiceNodeHeartbeatRequest({
        domainId: DOMAIN_ID,
        connectedRelay: 'wss://relay.example.test',
      }),
    ).toEqual({
      ok: true,
      value: { domainId: DOMAIN_ID, connectedRelay: 'wss://relay.example.test' },
    });
  });

  test('requires the relay the node is attached to', () => {
    const parsed = parseServiceNodeHeartbeatRequest({ domainId: DOMAIN_ID });

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.error).toBe('connectedRelay is required');
  });
});
