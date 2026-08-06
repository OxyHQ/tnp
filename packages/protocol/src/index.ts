/**
 * The protocol the relay, client, service node and embedded relay speak TODAY:
 * a five-byte header with no version, no length field, no bounds and a 32-bit
 * circuit id allocated from a per-process counter (audit S1, S6).
 *
 * Its replacement is `@tnp/protocol/v1`, specified in
 * docs/architecture/transport.md and implemented alongside it. The two are NOT
 * bridged and there is no compatibility layer: a v1 peer refuses a v0 peer
 * outright rather than misreading it. Cutting the four components over is a
 * single coordinated change, so until that lands this export is what they use.
 */
export * from "./frames.js";
