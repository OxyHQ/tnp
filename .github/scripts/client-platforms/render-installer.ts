/**
 * Write an installer exactly as the API serves it (version, repository and
 * release key filled in from @tnp/shared-types), for the client end-to-end
 * tests (.github/workflows/client-platforms.yml).
 *
 *   bun render-installer.ts install.sh|install.ps1 <out-file>
 */

import { writeFileSync } from 'node:fs';
import { CLIENT_VERSION, INSTALL_PS1, INSTALL_SH } from '../../../apps/api/src/routes/client.ts';

const [which, out] = process.argv.slice(2);
if ((which !== 'install.sh' && which !== 'install.ps1') || !out) {
  console.error('usage: bun render-installer.ts install.sh|install.ps1 <out-file>');
  process.exit(2);
}
writeFileSync(out, which === 'install.sh' ? INSTALL_SH : INSTALL_PS1);
console.log(`${which} for v${CLIENT_VERSION} written to ${out}`);
