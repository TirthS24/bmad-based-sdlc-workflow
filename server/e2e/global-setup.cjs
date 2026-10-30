// Playwright 1.49 cannot load ESM on Node 24, so the stack runs in a child process and this file
// (CommonJS) only waits for its READY line and hands the URL to the workers via the environment.
const { spawn } = require('node:child_process');
const path = require('node:path');

module.exports = async function globalSetup() {
  const child = spawn(process.execPath, [path.join(__dirname, 'stack.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const line = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; const m = /READY (\S+) (.+)\n/.exec(buf); if (m) resolve(m); });
    child.on('exit', (code) => reject(new Error(`stack exited early (${code})`)));
    setTimeout(() => reject(new Error('stack did not start in 60s')), 60000);
  });
  process.env.DASH_BASE = line[1];
  process.env.DASH_PASSWORD = line[2];
  return async () => {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
  };
};
