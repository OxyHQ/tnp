import { startEcosystemActivity, stopEcosystemActivity } from './ecosystemActivity.js';
import { config } from './config.js';
import { runSeed } from './seed.js';
import { createApp } from './app.js';
import { closePostgres, connectPostgres, getDb } from './db/postgres.js';
import { runMigrations } from './db/migrate.js';
import { readServicesConfig } from './services/config.js';
import { createProductionServicesRouter } from './services/routes.js';
import { logError } from './utils/logError.js';

// The optional services layer is built here and handed to the app: this file
// is the one place the network may import it from (docs/architecture/services.md).
// Every action is off unless its flag is set, and no adapter is constructed
// until a flagged route needs one.
const app = createApp({
  servicesRouter: createProductionServicesRouter(readServicesConfig(), getDb),
});

async function start() {
  let ready = false;
  startEcosystemActivity(() => ready);
  // Migrations run before the pool opens, so the process cannot begin serving
  // against a schema it has not migrated.
  await runMigrations();
  await connectPostgres();
  console.log('Connected to PostgreSQL');

  await runSeed();

  const server = app.listen(config.port, () => {
    ready = true;
    console.log(`TNP API running on http://localhost:${config.port}`);
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    ready = false;
    server.close(() => {
      void stopEcosystemActivity()
        .finally(() => closePostgres())
        .catch(() => {
          console.error('Failed to close activity publisher or database');
          process.exitCode = 1;
        });
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

start().catch((err) => {
  logError('Failed to start TNP API:', err);
  process.exit(1);
});
