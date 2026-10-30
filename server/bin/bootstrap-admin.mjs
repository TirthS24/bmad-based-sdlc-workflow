#!/usr/bin/env node
// Creates (or resets) the first admin. Runs on the server host, against DATABASE_URL, and is
// the only way an admin account comes to exist. Password comes from stdin, not argv.
import fs from 'node:fs';
import { createAdmin } from '../src/auth.mjs';
import { loadConfig } from '../src/config.mjs';
import { createPool, migrate } from '../src/db.mjs';

const email = process.argv[process.argv.indexOf('--email') + 1];
if (!email || email.startsWith('--')) {
  process.stderr.write('usage: bootstrap-admin.mjs --email you@example.com < password-file   (password read from stdin)\n');
  process.exit(1);
}
const password = fs.readFileSync(0, 'utf8').split('\n')[0];
const config = loadConfig();
const pool = createPool(config);
try {
  await migrate(pool);
  await createAdmin(pool, { email, password, minLength: config.minPasswordLength });
  process.stdout.write(`admin ready: ${email}\n`);
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
