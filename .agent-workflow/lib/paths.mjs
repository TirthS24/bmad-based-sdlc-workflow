// Where workflow files live. WF_DIR and REPO_ROOT can be overridden by env (tests do).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WF_DIR = path.resolve(process.env.WF_DIR || THIS_DIR);
export const REPO_ROOT = path.resolve(process.env.REPO_ROOT || path.dirname(WF_DIR));

export const PATHS = {
  workflow: path.join(WF_DIR, 'workflow.json'),
  config: path.join(WF_DIR, 'config.json'),
  state: path.join(WF_DIR, 'state.json'),
  events: path.join(WF_DIR, 'events.jsonl'),
  allowlist: path.join(WF_DIR, 'bmad-allowlist.json'),
  runs: path.join(WF_DIR, 'runs'),
};

export function specDir(state) {
  return path.join(REPO_ROOT, 'specs', `spec-${state.run.id}`);
}

export function posixRel(file) {
  return path.relative(REPO_ROOT, path.resolve(REPO_ROOT, file)).split(path.sep).join('/');
}
