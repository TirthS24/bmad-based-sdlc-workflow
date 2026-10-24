// Hash of every file matching test_globs, stored when the tests stage completes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { matchesAnyGlob } from './globs.mjs';
import { REPO_ROOT, posixRel } from './paths.mjs';

export function collectTestFiles(config) {
  const files = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === '.next') continue;
      if (ent.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(REPO_ROOT);
  return files
    .map((f) => posixRel(f))
    .filter((rel) => matchesAnyGlob(rel, config.test_globs))
    .sort();
}

export function freezeHash(config) {
  const files = collectTestFiles(config);
  const h = crypto.createHash('sha256');
  for (const rel of files) {
    const full = path.join(REPO_ROOT, rel);
    h.update(rel);
    h.update('\0');
    h.update(fs.readFileSync(full));
    h.update('\0');
  }
  return h.digest('hex');
}
