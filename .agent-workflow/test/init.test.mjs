// wf init: stack detection, config fill that never clobbers edits, and hash-bound pack approval.
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeRepo as baseRepo } from './helpers.mjs';

function makeRepo() {
  const r = baseRepo();
  r.config({ commands: { unit: '', lint: '' } });
  return r;
}

const project = (r) => JSON.parse(r.read('.agent-workflow/project.json'));
const cfg = (r) => JSON.parse(r.read('.agent-workflow/config.json'));
const CONTEXT = '## Stack\nx\n## Layout\nx\n## Commands\nx\n## Conventions\nx\n';

test('node project: detects typescript-react and fills blank test and lint commands', () => {
  const r = makeRepo();
  r.file('package.json', JSON.stringify({
    scripts: { test: 'vitest', lint: 'eslint .' },
    dependencies: { react: '18' },
    devDependencies: { typescript: '5' },
  }));
  r.file('yarn.lock', '');
  const res = r.run(['init']);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(project(r).stacks.map((s) => s.id), ['typescript-react']);
  assert.equal(cfg(r).commands.unit, 'yarn test');
  assert.equal(cfg(r).commands.lint, 'yarn run lint');
  assert.match(res.stdout, /\/wf-onboard/);
});

test('python project', () => {
  const r = makeRepo();
  r.file('pyproject.toml', '[project]\nname="x"\n');
  r.run(['init']);
  assert.deepEqual(project(r).stacks.map((s) => s.id), ['python']);
  assert.equal(cfg(r).commands.unit, 'pytest');
});

test('pom.xml only: detects java-maven with no pack yet', () => {
  const r = makeRepo();
  r.file('pom.xml', '<project/>');
  r.run(['init']);
  const p = project(r);
  assert.deepEqual(p.stacks.map((s) => s.id), ['java-maven']);
  assert.equal(p.packs['java-maven'], 'needs-draft');
  assert.equal(cfg(r).commands.unit, 'mvn -q test');
});

test('empty directory: no stacks, config untouched, nothing crashes', () => {
  const r = makeRepo();
  const before = r.read('.agent-workflow/config.json');
  const res = r.run(['init']);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(project(r).stacks, []);
  assert.match(res.stdout, /no known stack files/);
  assert.equal(r.read('.agent-workflow/config.json'), before);
});

test('monorepo: finds a stack one folder down', () => {
  const r = makeRepo();
  r.file('backend/requirements.txt', 'django');
  r.file('node_modules/x/package.json', '{}');
  r.run(['init']);
  assert.deepEqual(project(r).stacks.map((s) => s.id), ['python']);
  assert.equal(cfg(r).commands.unit, '', 'a nested stack does not set root commands');
});

test('refresh keeps user edits but updates fields init wrote itself', () => {
  const r = makeRepo();
  r.file('package.json', JSON.stringify({ scripts: { test: 'jest', lint: 'eslint .' } }));
  r.run(['init']);
  r.config({ commands: { lint: 'my-own-lint' } });
  r.file('package.json', JSON.stringify({ scripts: { test: 'vitest', lint: 'biome check' } }));
  r.run(['init', '--refresh']);
  assert.equal(cfg(r).commands.lint, 'my-own-lint', 'user edit stays');
  assert.equal(cfg(r).commands.unit, 'npm test');
  r.config({ commands: { unit: 'make test' } });
  r.run(['init', '--refresh']);
  assert.equal(cfg(r).commands.unit, 'make test');
});

test('a second plain init does not re-detect', () => {
  const r = makeRepo();
  r.run(['init']);
  r.file('pom.xml', '<project/>');
  const res = r.run(['init']);
  assert.match(res.stdout, /already initialised/);
  assert.deepEqual(project(r).stacks, []);
});

test('check fails until the context exists and every pack is approved', () => {
  const r = makeRepo();
  r.file('pom.xml', '<project/>');
  r.run(['init']);
  let res = r.run(['init', '--check']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /project-context\.md/);
  assert.match(res.stderr, /java-maven: no rule pack/);

  r.file('.agent-workflow/context/project-context.md', '## Stack\nonly this\n');
  assert.match(r.run(['init', '--check']).stderr, /needs sections: Layout, Commands, Conventions/);

  r.file('.agent-workflow/context/project-context.md', CONTEXT);
  r.file('.agent-workflow/rules/java-maven.md', '# Java rules\n');
  r.run(['init', '--refresh']);
  assert.match(r.run(['init', '--check']).stderr, /awaits human approval/);
});

test('approval is bound to the file hash: draft, approved, edited back to draft', () => {
  const r = makeRepo();
  r.file('pom.xml', '<project/>');
  r.file('.agent-workflow/context/project-context.md', CONTEXT);
  r.file('.agent-workflow/rules/java-maven.md', '# v1\n');
  r.run(['init']);
  assert.equal(project(r).packs['java-maven'], 'draft');
  assert.notEqual(r.run(['init', '--check']).status, 0);

  assert.equal(r.run(['init', '--approve-pack', 'java-maven']).status, 0);
  assert.equal(r.run(['init', '--check']).status, 0);
  assert.ok(r.events().some((e) => e.type === 'init_pack_approved'));

  r.file('.agent-workflow/rules/java-maven.md', '# v2 edited by an agent\n');
  assert.notEqual(r.run(['init', '--check']).status, 0, 'edit revokes approval');
});

test('approve-pack refuses a missing pack; rules lists generic plus approved packs only', () => {
  const r = makeRepo();
  r.file('pom.xml', '<project/>');
  r.file('.agent-workflow/rules/generic.md', '# g\n');
  r.file('.agent-workflow/rules/java-maven.md', '# j\n');
  r.run(['init']);
  assert.notEqual(r.run(['init', '--approve-pack', 'nope']).status, 0);
  assert.equal(r.run(['init', '--rules']).stdout.trim(), '.agent-workflow/rules/generic.md');
  r.run(['init', '--approve-pack', 'java-maven']);
  assert.equal(r.run(['init', '--rules']).stdout.trim().split('\n').length, 2);
});

test('init refuses while a run is active', () => {
  const r = makeRepo();
  r.startRun('feat');
  const res = r.run(['init']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /run is active/);
});

test('playwright and typescript: suggests e2e, typecheck and format commands', () => {
  const r = makeRepo();
  r.file('package.json', JSON.stringify({ devDependencies: { '@playwright/test': '1', prettier: '3', typescript: '5' } }));
  r.file('tsconfig.json', '{}');
  r.run(['init']);
  assert.equal(cfg(r).commands.e2e, 'npx playwright test --reporter=list,json');
  assert.equal(cfg(r).commands.typecheck, 'npx tsc --noEmit');
  assert.equal(cfg(r).commands.format, 'npx prettier --check .');
});

test('shipped packs need no approval; a drafted one still does', () => {
  const r = makeRepo();
  r.file('pyproject.toml', '[project]\nname="x"\n');
  r.file('pom.xml', '<project/>');
  r.file('.agent-workflow/context/project-context.md', CONTEXT);
  r.file('.agent-workflow/rules/python.md', '# p\n');
  r.file('.agent-workflow/rules/java-maven.md', '# j\n');
  r.run(['init']);
  assert.equal(project(r).packs.python, 'approved');
  assert.equal(project(r).packs['java-maven'], 'draft');
  assert.match(r.run(['init', '--check']).stderr, /java-maven: pack awaits/);
  assert.doesNotMatch(r.run(['init', '--check']).stderr, /stack python/);
});

test('src_globs: replaced when still the default, kept after a user edit', () => {
  const r = makeRepo();
  r.file('backend/requirements.txt', 'django');
  r.run(['init']);
  assert.deepEqual(cfg(r).src_globs, ['backend/**']);
  r.file('app/x.txt', 'x');
  r.run(['init', '--refresh']);
  assert.deepEqual(cfg(r).src_globs, ['app/**', 'backend/**'], 'init-written value follows the project');
  r.config({ src_globs: ['custom/**'] });
  r.file('server/x.txt', 'x');
  r.run(['init', '--refresh']);
  assert.deepEqual(cfg(r).src_globs, ['custom/**']);
});
