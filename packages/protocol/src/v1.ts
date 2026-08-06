/**
 * TNP wire protocol v1.
 *
 * Normative spec: docs/architecture/transport.md.
 *
 * Exported under `@tnp/protocol/v1` rather than replacing the default export,
 * because the cutover from v0 touches the relay, the client, the service node
 * and the embedded relay together. When that lands, this becomes the default
 * and `frames.ts` is deleted — not deprecated, deleted.
 */
export * from "./constants.js";
export * from "./frame.js";
export * from "./circuit-id.js";
export * from "./flow-control.js";
