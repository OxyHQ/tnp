/**
 * TNP wire protocol v1 (docs/architecture/transport.md) — the only protocol
 * the client, relay, service node and embedded relay speak.
 *
 * The unversioned five-byte-header v0 codec was deleted in the cutover, not
 * deprecated: a v1 peer refuses a v0 peer at the version byte.
 * `@tnp/protocol/v1` remains as an alias of this entry point.
 */
export * from './v1.js';
