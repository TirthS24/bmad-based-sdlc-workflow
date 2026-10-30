// A scripted pipeline: the real wf CLI driven through every stage with stub artifacts, the way
// docs/BASELINE.md describes for a real baseline. The agents are stubs, so this validates the
// telemetry path end to end; it does not measure LLM time or cost.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ADR, AXES, VALID_SPEC, WF_ENTRY } from '../../.agent-workflow/test/helpers.mjs';

export function makeWf(repo, home) {
  return (args, input = '') => new Promise((resolve) => {
    const child = spawn(process.execPath, [WF_ENTRY, ...args], {
      cwd: repo.root,
      env: { ...repo.env, WF_HOME: home },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

export const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wf-home-'));

const VALID_APPROACH = `# Approach\nVerdict: with-changes\n## Approach A\nSmall change.\n## Approach B\nBigger change.\nFits in one commit.\n${ADR}`;

// scenario: clean | rejected | stuck | aborted
export async function runPipeline({ repo, wf, name, scenario }) {
  const must = async (args, input) => {
    const r = await wf(args, input);
    if (r.status !== 0) throw new Error(`${scenario}: wf ${args.join(' ')} failed: ${r.stderr}`);
    return r;
  };
  await must(['run', name]);
  const id = JSON.parse(fs.readFileSync(path.join(repo.wfDir, 'state.json'), 'utf8')).run.id;
  const dir = `specs/spec-${id}`;
  const setCommands = (commands) => repo.config({ commands });

  if (scenario === 'aborted') {
    repo.guard('preToolUse', { tool_name: 'Write', tool_input: { file_path: 'src/too-early.py' } });
    await must(['report-failure', 'agent_crash', 'solution-architect']);
    await must(['abort', '--force']);
    return { id, manual: false, completed: false };
  }

  repo.seedPlanning(id);
  await must(['done', 'planning', '--result', `${dir}/SRS.md`]);
  if (scenario === 'rejected') {
    await must(['reject', 'gate_spec', '--reason', 'goals are too broad']);
    await must(['done', 'planning', '--result', `${dir}/SRS.md`]);
  }
  await must(['approve', 'gate_spec']);
  repo.file(`${dir}/approach.md`, VALID_APPROACH);
  await must(['done', 'feasibility']);
  await must(['approve', 'gate_approach', '--approach', 'A']);
  setCommands({ unit: 'echo FAILED REQ-1; exit 1', lint: '' });
  repo.file('tests/test_items.py', 'placeholder');
  await must(['done', 'tests', '--result', 'tests']);
  await must(['approve', 'gate_tests']);

  let manual = false;
  if (scenario === 'stuck') {
    for (let i = 0; i < 3; i += 1) await wf(['guard', 'stop'], '{}');
    const list = await must(['escalation', 'list']);
    if (!/CRITICAL implement/.test(list.stdout)) throw new Error('expected an escalation');
    manual = true;
    await must(['escalation', 'retry', '--reason', 'fixed the fixture by hand']);
  }
  setCommands({ unit: 'exit 0', lint: '' });
  repo.file('src/items.py', 'print(1)');
  await must(['done', 'implement']);
  repo.file(`.agent-workflow/runs/${id}/review.md`, `${AXES}- [low] src/items.py:1 - rename\n`);
  await must(['done', 'review', '--result', `.agent-workflow/runs/${id}/review.md`]);
  await must(['approve', 'gate_review']);
  repo.file(`.agent-workflow/runs/${id}/evidence/report.txt`, 'ok');
  await must(['done', 'verify']);
  await must(['approve', 'gate_final']);
  await must(['adr']);
  repo.file(`.agent-workflow/runs/${id}/pr-summary.md`, 'Adds the items view.');
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'feat: items');
  await must(['pr']);
  return { id, manual, completed: true };
}
