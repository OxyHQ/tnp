import { createOptionalOxyAuth } from '@oxy.so/core/server';
import { oxy } from '../oxy.js';

// Optional Oxy auth: resolves req.userId / req.user when a valid bearer token
// is present, and lets a request with no token through anonymously. A token
// that IS presented and does not verify is refused (401), and an Oxy outage
// while checking it is a 503 — never a silent downgrade to anonymous
// (`strictOptionalBearer`). Route handlers enforce auth with `requireOxyAuth`
// from @oxy.so/core/server.
export const oxyAuthOptional = createOptionalOxyAuth(oxy, {
  auth: { strictOptionalBearer: true },
});
