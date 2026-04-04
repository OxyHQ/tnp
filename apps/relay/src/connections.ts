import type { ServerWebSocket } from "bun";

export interface ServiceNodeData {
  domain: string;
}

export interface ClientData {
  type: "client";
}

export interface Circuit {
  circuitId: number;
  clientWs: ServerWebSocket<ClientData>;
  domain: string;
  serviceWs: ServerWebSocket<ServiceNodeData>;
}

/**
 * Manages service-node registrations and client circuits.
 *
 * A "service node" is a long-lived WebSocket that serves traffic for a
 * specific domain.  A "circuit" links a single client request to a
 * service node via a numeric circuitId that both sides include in every
 * frame.
 */
export class ConnectionManager {
  /** domain -> service-node WebSocket */
  private serviceNodes = new Map<string, ServerWebSocket<ServiceNodeData>>();

  /** circuitId -> Circuit */
  private circuits = new Map<number, Circuit>();

  // ---- service nodes ----

  registerServiceNode(domain: string, ws: ServerWebSocket<ServiceNodeData>): void {
    const existing = this.serviceNodes.get(domain);
    if (existing) {
      console.log(`[relay] replacing existing service node for ${domain}`);
      this.removeAllCircuitsForServiceNode(domain);
    }
    this.serviceNodes.set(domain, ws);
    console.log(
      `[relay] service node registered: ${domain} (total: ${this.serviceNodes.size})`,
    );
  }

  removeServiceNode(domain: string): void {
    this.serviceNodes.delete(domain);
    this.removeAllCircuitsForServiceNode(domain);
    console.log(
      `[relay] service node removed: ${domain} (total: ${this.serviceNodes.size})`,
    );
  }

  hasServiceNode(domain: string): boolean {
    return this.serviceNodes.has(domain);
  }

  getServiceNode(domain: string): ServerWebSocket<ServiceNodeData> | undefined {
    return this.serviceNodes.get(domain);
  }

  // ---- circuits ----

  /**
   * Open a circuit from a client to a service node.
   * Returns `true` if the service node exists and the circuit was created,
   * `false` otherwise (caller should send an ERROR frame).
   */
  openCircuit(
    circuitId: number,
    clientWs: ServerWebSocket<ClientData>,
    domain: string,
  ): boolean {
    const serviceWs = this.serviceNodes.get(domain);
    if (!serviceWs) {
      return false;
    }

    if (this.circuits.has(circuitId)) {
      console.log(`[relay] circuit ${circuitId} already exists, closing old one`);
      this.closeCircuit(circuitId);
    }

    this.circuits.set(circuitId, { circuitId, clientWs, domain, serviceWs });
    console.log(
      `[relay] circuit opened: ${circuitId} -> ${domain} (active: ${this.circuits.size})`,
    );
    return true;
  }

  getCircuit(circuitId: number): Circuit | undefined {
    return this.circuits.get(circuitId);
  }

  closeCircuit(circuitId: number): void {
    const removed = this.circuits.delete(circuitId);
    if (removed) {
      console.log(
        `[relay] circuit closed: ${circuitId} (active: ${this.circuits.size})`,
      );
    }
  }

  /**
   * Remove every circuit that references `ws` (either as client or service
   * node).  Called when a WebSocket disconnects.
   */
  removeAllCircuits(ws: ServerWebSocket<unknown>): number {
    let removed = 0;
    for (const [id, circuit] of this.circuits) {
      if (
        (circuit.clientWs as ServerWebSocket<unknown>) === ws ||
        (circuit.serviceWs as ServerWebSocket<unknown>) === ws
      ) {
        this.circuits.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(
        `[relay] removed ${removed} circuit(s) for disconnected socket (active: ${this.circuits.size})`,
      );
    }
    return removed;
  }

  // ---- stats ----

  get serviceNodeCount(): number {
    return this.serviceNodes.size;
  }

  get circuitCount(): number {
    return this.circuits.size;
  }

  // ---- internal helpers ----

  /**
   * Close all circuits that route through a specific domain's service node.
   */
  private removeAllCircuitsForServiceNode(domain: string): void {
    let removed = 0;
    for (const [id, circuit] of this.circuits) {
      if (circuit.domain === domain) {
        this.circuits.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(
        `[relay] removed ${removed} circuit(s) for service node ${domain} (active: ${this.circuits.size})`,
      );
    }
  }
}
