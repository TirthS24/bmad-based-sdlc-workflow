// Where workflow files live. WF_DIR and REPO_ROOT can be overridden by env (tests do).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function wfDir() {
  return path.resolve(process.env.WF_DIR || THIS_DIR);
}
export function repoRoot() {
  return path.resolve(process.env.REPO_ROOT || path.dirname(wfDir()));
}
export const WF_DIR = wfDir();
export const REPO_ROOT = repoRoot();

export const PATHS = {
  workflow: path.join(wfDir(), 'workflow.json'),
  config: path.join(wfDir(), 'config.json'),
  state: path.join(wfDir(), 'state.json'),
  events: path.join(wfDir(), 'events.jsonl'),
  allowlist: path.join(wfDir(), 'bmad-allowlist.json'),
  runs: path.join(wfDir(), 'runs'),
};

export function specDir(state) {
  return path.join(repoRoot(), 'specs', `spec-${state.run.id}`);
}

export function posixRel(file) {
  const root = repoRoot();
  return path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
}
