// Starts the server: migrate, then listen. Configuration is environment-only (see config.mjs).
import { createApp } from './app.mjs';
import { loadConfig } from './config.mjs';
import { createPool, migrate } from './db.mjs';

const config = loadConfig();
const pool = createPool(config);
const applied = await migrate(pool);
if (applied.length) process.stdout.write(`applied migrations: ${applied.join(', ')}\n`);
createApp({ pool, config }).listen(config.port, () => process.stdout.write(`telemetry server on :${config.port}\n`));
