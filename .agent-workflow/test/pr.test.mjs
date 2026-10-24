// `wf pr`: PR body, push, and gh pr create.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fresh, withRun } from './helpers.mjs';

const SUMMARY = 'Adds a GET /items endpoint that returns all items as JSON.\nUnknown ids now return a 404 instead of a server error.';

function writeSummary(repo, id, text = SUMMARY) {
  fs.mkdirSync(path.join(repo.wfDir, 'runs', id), { recursive: true });
  fs.writeFileSync(path.join(repo.wfDir, 'runs', id, 'pr-summary.md'), `${text}\n`);
}

function readyForPr(repo, id, { summary = true } = {}) {
  if (summary) writeSummary(repo, id);
  repo.seedSpecs(id);
  repo.file('src/app.py', 'print(1)');
  repo.commit('feat: thing');
  repo.update((s) => {
    s.current.stage = 'pr';
    s.gates.gate_final = { status: 'approved' };
    s.gates.gate_approach = { status: 'approved', approach: 'B' };
    s.stages.verify = { status: 'done', tiers: [
      { tier: 'unit', skipped: false, code: 0 },
      { tier: 'lint', skipped: false, code: 0 },
      { tier: 'e2e', skipped: true, code: 0 },
    ] };
  });
}

test('pr needs a run, the pr stage, and an approved final gate', (t) => {
  const repo = fresh(t);
  assert.match(repo.run(['pr']).stderr, /no active run/);
  repo.startRun('feat');
  assert.match(repo.run(['pr']).stderr, /current stage is grill_spec, not pr/);
  repo.setStage('pr');
  assert.match(repo.run(['pr']).stderr, /gate_final is not approved/);
});

test('pr --dry-run writes and prints the body without pushing or calling gh', (t) => {
  const { repo, id } = withRun(t, 'Add Items Endpoint');
  const remote = repo.addRemoteAndFakeGh();
  t.after(remote.cleanup);
  readyForPr(repo, id);
  const res = repo.run(['pr', '--dry-run']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^title: Add Items Endpoint$/m);
  assert.match(res.stdout, new RegExp(`^head: wf/${id}$`, 'm'));
  assert.match(res.stdout, /^base: (main|master)$/m);
  assert.match(res.stdout, /## Summary/);
  assert.match(res.stdout, /- Approach: B/);
  assert.match(res.stdout, /## What changed\n\nAdds a GET \/items endpoint that returns all items as JSON\.\nUnknown ids now return a 404 instead of a server error\.\n/);
  assert.match(res.stdout, /<details><summary>Files changed<\/summary>[\s\S]*src\/app\.py\s+\|[\s\S]*<\/details>/);
  assert.match(res.stdout, /## Acceptance criteria\n\n- \[ \] \*\*REQ-1\*\* Do the thing — success: it works/);
  assert.match(res.stdout, /\| unit \| passed \|/);
  assert.match(res.stdout, /\| e2e \| skipped \(no command configured\) \|/);
  assert.match(res.stdout, /## Risk note/);
  assert.match(res.stdout, /- Checks skipped: e2e/);
  assert.ok(fs.existsSync(path.join(repo.wfDir, 'runs', id, 'pr-body.md')));
  assert.equal(remote.ghArgs(), null, 'gh was not called');
  assert.equal(remote.remoteBranches().trim(), '', 'nothing was pushed');
  assert.equal(repo.state().current.stage, 'pr', 'stage unchanged');
});

test('pr refuses to open a PR without a change summary, but a dry run shows what is missing', (t) => {
  const { repo, id } = withRun(t);
  const remote = repo.addRemoteAndFakeGh();
  t.after(remote.cleanup);
  readyForPr(repo, id, { summary: false });
  const dry = repo.run(['pr', '--dry-run']);
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /\(missing: write a plain-language summary to \.agent-workflow\/runs\/.*\/pr-summary\.md\)/);
  const real = repo.run(['pr']);
  assert.equal(real.status, 1);
  assert.match(real.stderr, /write a plain-language summary of the code changes to \.agent-workflow\/runs\/.*\/pr-summary\.md first/);
  assert.equal(remote.ghArgs(), null);
  assert.equal(remote.remoteBranches().trim(), '');
  writeSummary(repo, id, '   \n');
  assert.equal(repo.run(['pr']).status, 1, 'a blank summary does not count');
  writeSummary(repo, id);
  assert.equal(repo.run(['pr']).status, 0);
});

test('pr --dry-run works before any commit exists', (t) => {
  const { repo, id } = withRun(t);
  repo.seedSpecs(id);
  repo.update((s) => { s.current.stage = 'pr'; s.gates.gate_final = { status: 'approved' }; });
  assert.equal(repo.run(['pr', '--dry-run']).status, 0);
});

test('risk note flags files outside src/tests/specs, dependency manifests, and changed frozen tests', (t) => {
  const { repo, id } = withRun(t);
  readyForPr(repo, id);
  repo.file('package.json', '{}');
  repo.file('infra/deploy.sh', 'x');
  repo.file('tests/test_a.py', 'one');
  repo.update((s) => { s.freeze.test_files_hash = 'stale'; s.escalations.push({ level: 'CRITICAL' }); s.rejections.push({ gate: 'gate_spec', reason: 'r', at: 'x' }); });
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'more');
  const out = repo.run(['pr', '--dry-run']).stdout;
  assert.match(out, /- Outside src, tests and specs: .*infra\/deploy\.sh/);
  assert.match(out, /- Dependency manifests touched: `package\.json`/);
  assert.match(out, /- Frozen tests changed since they were approved: YES/);
  assert.match(out, /- Gate rejections during the run: 1/);
  assert.match(out, /- Escalations during the run: 1/);
});

test('pr pushes the run branch, calls gh pr create, and records the URL', (t) => {
  const { repo, id } = withRun(t, 'Add Items Endpoint');
  const remote = repo.addRemoteAndFakeGh({ ghOut: 'Creating pull request...\nhttps://github.com/acme/app/pull/7' });
  t.after(remote.cleanup);
  readyForPr(repo, id);
  const res = repo.run(['pr']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'https://github.com/acme/app/pull/7');
  assert.match(remote.remoteBranches(), new RegExp(`wf/${id}`));
  const base = repo.state().run.base_branch;
  assert.deepEqual(remote.ghArgs(), [
    'pr', 'create',
    '--base', base,
    '--head', `wf/${id}`,
    '--title', 'Add Items Endpoint',
    '--body-file', path.join(repo.wfDir, 'runs', id, 'pr-body.md'),
  ]);
  const s = repo.state();
  assert.equal(s.current.stage, 'done');
  assert.equal(s.pr.url, 'https://github.com/acme/app/pull/7');
  assert.equal(s.stages.pr.result, 'https://github.com/acme/app/pull/7');
  assert.deepEqual(repo.events().at(-1), { ts: repo.events().at(-1).ts, type: 'pr_created', url: 'https://github.com/acme/app/pull/7' });
});

test('pr refuses when there is no commit since the baseline', (t) => {
  const { repo, id } = withRun(t);
  const remote = repo.addRemoteAndFakeGh();
  t.after(remote.cleanup);
  repo.seedSpecs(id);
  writeSummary(repo, id);
  repo.update((s) => { s.current.stage = 'pr'; s.gates.gate_final = { status: 'approved' }; });
  const res = repo.run(['pr']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no commits since [0-9a-f]{40}; commit the run files first/);
  assert.equal(remote.ghArgs(), null);
});

test('pr reports push and gh failures and stays on the pr stage', (t) => {
  const { repo, id } = withRun(t);
  readyForPr(repo, id);
  const noRemote = repo.run(['pr']);
  assert.equal(noRemote.status, 1);
  assert.match(noRemote.stderr, /git push failed:/);

  const remote = repo.addRemoteAndFakeGh({ ghExit: 1, ghOut: 'boom' });
  t.after(remote.cleanup);
  const ghFail = repo.run(['pr']);
  assert.equal(ghFail.status, 1);
  assert.match(ghFail.stderr, /gh pr create failed:/);

  const noUrl = repo.addRemoteAndFakeGh({ ghOut: 'created but no link' });
  t.after(noUrl.cleanup);
  repo.git('remote', 'set-url', 'origin', noUrl.remote);
  const res = repo.run(['pr']);
  assert.match(res.stderr, /gh pr create printed no PR URL: created but no link/);
  assert.equal(repo.state().current.stage, 'pr');
  assert.equal(repo.state().pr, undefined);
});

test('a long source becomes a 72-character title', (t) => {
  const { repo, id } = withRun(t, 'x'.repeat(90));
  readyForPr(repo, id);
  const title = /^title: (.*)$/m.exec(repo.run(['pr', '--dry-run']).stdout)[1];
  assert.equal(title.length, 72);
  assert.ok(title.endsWith('...'));
});
