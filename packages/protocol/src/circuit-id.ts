/**
 * Circuit and stream identifiers.
 *
 * The defect this exists to end (audit S1): the old client allocated circuit
 * IDs from `nextCircuitId = 1`, incrementing per process, and the relay kept
 * ONE global `Map<number, Circuit>` keyed by whatever the client sent, with no
 * check that the requesting socket owned that circuit.
 *
 * Two consequences, and the first needs no attacker at all:
 *
 *  - Two honest clients both started at 1, so their circuits collided on a
 *    shared relay immediately.
 *  - A hostile client could close, or inject frames into, another client's
 *    circuit by guessing a small integer — and the integers were not merely
 *    guessable, they were consecutive from 1.
 *
 * Identifiers here are 64-bit and drawn from a CSPRNG, so a collision between
 * honest peers is negligible and guessing is infeasible. That is necessary but
 * not sufficient: the relay must ALSO key its tables per connection, which is
 * `CircuitTable`'s job.
 */

import { webcrypto } from "crypto";

/** Zero is reserved for connection-level control frames. */
const RESERVED_CIRCUIT_ID = 0n;

/** Zero is reserved for circuit-level control frames. */
const RESERVED_STREAM_ID = 0;

/**
 * A cryptographically random 64-bit circuit identifier, never zero.
 *
 * Not a counter. A counter is guessable by construction, and shared starting
 * points across processes make collisions certain rather than negligible.
 */
export function generateCircuitId(): bigint {
  const bytes = new Uint8Array(8);
  for (;;) {
    webcrypto.getRandomValues(bytes);
    let id = 0n;
    for (const byte of bytes) id = (id << 8n) | BigInt(byte);
    if (id !== RESERVED_CIRCUIT_ID) return id;
  }
}

/** A cryptographically random 32-bit stream identifier, never zero. */
export function generateStreamId(): number {
  const bytes = new Uint32Array(1);
  for (;;) {
    webcrypto.getRandomValues(bytes);
    if (bytes[0] !== RESERVED_STREAM_ID) return bytes[0];
  }
}

/**
 * Circuits belonging to ONE connection.
 *
 * The type exists so that "which connection owns this circuit" cannot be
 * forgotten: there is no global table to look a circuit up in, because a table
 * only ever holds one peer's circuits. A frame arriving on a connection can
 * only ever reach that connection's own table.
 */
export class CircuitTable<T> {
  private readonly circuits = new Map<bigint, T>();

  constructor(private readonly maxCircuits: number) {}

  get size(): number {
    return this.circuits.size;
  }

  get atCapacity(): boolean {
    return this.circuits.size >= this.maxCircuits;
  }

  has(circuitId: bigint): boolean {
    return this.circuits.has(circuitId);
  }

  get(circuitId: bigint): T | undefined {
    return this.circuits.get(circuitId);
  }

  /**
   * Insert a circuit.
   *
   * Returns false when the table is full or the id is already taken. It does
   * NOT evict the existing entry to make room: the old relay closed a colliding
   * circuit and replaced it, which is precisely how one peer could displace
   * another's.
   */
  add(circuitId: bigint, circuit: T): boolean {
    if (circuitId === RESERVED_CIRCUIT_ID) return false;
    if (this.circuits.has(circuitId)) return false;
    if (this.atCapacity) return false;
    this.circuits.set(circuitId, circuit);
    return true;
  }

  delete(circuitId: bigint): T | undefined {
    const circuit = this.circuits.get(circuitId);
    if (circuit) this.circuits.delete(circuitId);
    return circuit;
  }

  /** Every circuit, for teardown when the connection closes. */
  drain(): T[] {
    const all = [...this.circuits.values()];
    this.circuits.clear();
    return all;
  }

  entries(): IterableIterator<[bigint, T]> {
    return this.circuits.entries();
  }
}
