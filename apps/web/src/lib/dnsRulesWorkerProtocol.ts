/**
 * Messages between the page and `dnsRulesWorker.ts`, and the `RulesCrypto`
 * that uses the worker when the browser can start one.
 */

import {
  type RulesEnvelope,
  RulesEnvelopeError,
  type RulesEnvelopeErrorCode,
} from '@tnp/crypto/dns-rules';
import { inlineCrypto, type RulesCrypto } from './dnsRules';

export type WorkerRequest =
  | { op: 'unlock'; args: { passphrase: string; userId: string; envelope: RulesEnvelope } }
  | { op: 'create'; args: { passphrase: string; userId: string; body: Uint8Array } };

export type WorkerResponse =
  | { ok: true; op: 'unlock'; rulesKey: Uint8Array }
  | { ok: true; op: 'create'; envelope: RulesEnvelope; rulesKey: Uint8Array }
  | { ok: false; code: RulesEnvelopeErrorCode; message: string };

function run(request: WorkerRequest): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./dnsRulesWorker.ts', import.meta.url), { type: 'module' });
    } catch (err) {
      reject(err);
      return;
    }
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'worker failed'));
    };
    worker.postMessage(request);
  });
}

function unwrap<T extends WorkerResponse & { ok: true }>(response: WorkerResponse): T {
  if (!response.ok) throw new RulesEnvelopeError(response.code, response.message);
  return response as T;
}

/**
 * `RulesCrypto` in a worker, falling back to the main thread if no worker can
 * start (the result is the same, the page just pauses while it runs). A
 * refusal from the crypto itself (wrong passphrase) is never retried inline.
 */
export const workerCrypto: RulesCrypto = {
  async unlock(args) {
    let response: WorkerResponse;
    try {
      response = await run({ op: 'unlock', args });
    } catch {
      return inlineCrypto.unlock(args);
    }
    return unwrap<{ ok: true; op: 'unlock'; rulesKey: Uint8Array }>(response).rulesKey;
  },
  async create(args) {
    let response: WorkerResponse;
    try {
      response = await run({ op: 'create', args });
    } catch {
      return inlineCrypto.create(args);
    }
    const { envelope, rulesKey } = unwrap<{
      ok: true;
      op: 'create';
      envelope: RulesEnvelope;
      rulesKey: Uint8Array;
    }>(response);
    return { envelope, rulesKey };
  },
};
