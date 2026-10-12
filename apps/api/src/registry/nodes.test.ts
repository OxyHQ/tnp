import { describe, expect, test } from 'bun:test';
import { SERVICE_NODE_STALE_AFTER_MS, toServiceNodeLookup } from './nodes.js';

const now = new Date('2026-10-12T12:00:00.000Z');
const node = {
  publicKey: 'Zm9vYmFyLXB1YmxpYy1rZXk=',
  connectedRelay: 'wss://relay.example.test',
  status: 'online' as const,
  lastSeen: new Date(now.getTime() - 10_000),
};

describe('toServiceNodeLookup', () => {
  test('a fresh node is online with its relay, and no timestamp is published', () => {
    const lookup = toServiceNodeLookup(node, now);
    expect(lookup).toEqual({
      publicKey: node.publicKey,
      connectedRelay: 'wss://relay.example.test',
      status: 'online',
      online: true,
    });
    expect(Object.keys(lookup)).not.toContain('lastSeen');
    expect(JSON.stringify(lookup)).not.toContain('2026-');
  });

  test('a stale node is offline and its last relay is withheld', () => {
    const stale = {
      ...node,
      lastSeen: new Date(now.getTime() - SERVICE_NODE_STALE_AFTER_MS - 1),
    };
    expect(toServiceNodeLookup(stale, now)).toEqual({
      publicKey: node.publicKey,
      connectedRelay: '',
      status: 'offline',
      online: false,
    });
  });

  test('a node whose stored status is offline is offline however recent', () => {
    expect(toServiceNodeLookup({ ...node, status: 'offline' }, now).online).toBe(false);
  });
});
