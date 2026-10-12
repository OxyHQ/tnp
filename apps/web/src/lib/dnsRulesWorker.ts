/**
 * Argon2id off the main thread. Bundled by Vite as a same-origin module
 * worker (allowed by `script-src 'self'`, which `worker-src` falls back to),
 * so a 64 MiB key derivation does not freeze the page.
 *
 * It receives the passphrase, does one derivation, posts the result and is
 * terminated by the caller; it keeps nothing.
 */

import { createRulesEnvelope, RulesEnvelopeError, unlockRulesKey } from '@tnp/crypto/dns-rules';
import type { WorkerRequest, WorkerResponse } from './dnsRulesWorkerProtocol';

// The DOM lib types `self` as a Window; in a worker it is the worker scope.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
};

scope.onmessage = (event) => {
  const request = event.data;
  let response: WorkerResponse;
  try {
    response =
      request.op === 'unlock'
        ? { ok: true, op: 'unlock', rulesKey: unlockRulesKey(request.args) }
        : { ok: true, op: 'create', ...createRulesEnvelope(request.args) };
  } catch (err) {
    response = {
      ok: false,
      code: err instanceof RulesEnvelopeError ? err.code : 'malformed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  scope.postMessage(response);
};
