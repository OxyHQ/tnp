/**
 * Test helper for pins.test.ts: one of several processes recording pins into
 * the same store at once. Not imported by the CLI.
 */

import { encodeBase64, generateSigningKeyPair } from '@tnp/crypto';
import { PinStore } from './pins';
import { OverlayStore } from './store';

const [root, worker, count = '15'] = process.argv.slice(2);
const pins = new PinStore(new OverlayStore(root, null));
for (let i = 0; i < Number(count); i++) {
  pins.record(`w${worker}n${i}.ox`, encodeBase64(generateSigningKeyPair().publicKey), [
    { key: 'k', serial: i },
  ]);
}
