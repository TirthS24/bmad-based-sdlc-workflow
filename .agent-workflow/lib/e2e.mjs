// Reads the Playwright JSON report the e2e tier produces, maps each test to the
// scenario ids in its title, and checks every automated product scenario in the
// test plan has a passing test. Pure file reading; no browser needed.
import fs from 'node:fs';
import path from 'node:path';
import { readText } from './io.mjs';
import { specDir } from './paths.mjs';
import { plannedScenarios } from './tickets.mjs';

const ID = /\b(?:REQ-\d+|PRD-\d+\.\d+|TECH-[\w-]+)\b/g;

// Playwright test.status: expected | unexpected | flaky | skipped.
const OUTCOME = { expected: 'passed', unexpected: 'failed', flaky: 'flaky', skipped: 'skipped' };

export function readE2eReport(file) {
  if (!file || !fs.existsSync(file)) return null;
  let report;
  try { report = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const out = [];
  const walk = (suite) => {
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        out.push({
          title: spec.title,
          file: spec.file || suite.file || '',
          outcome: OUTCOME[t.status] || (spec.ok ? 'passed' : 'failed'),
          ids: spec.title.match(ID) || [],
        });
      }
    }
    (suite.suites || []).forEach(walk);
  };
  (report.suites || []).forEach(walk);
  return out;
}

// Product scenarios (PRD-n.m) the plan marks automated on a user-facing layer (e2e, ui or
// api). Each needs a passing Playwright test.
export function plannedE2e(state) {
  return plannedScenarios(state);
}

// Planned automated product scenarios must run; an empty e2e command would skip them silently.
export function e2eNotConfigured(state, config) {
  const planned = plannedE2e(state);
  if (!planned.length || String(config.commands?.e2e || '').trim()) return null;
  return `ticket ACs plan automated product scenarios (${planned.join(', ')}) but commands.e2e is empty`;
}

export function checkE2eCoverage(state, tests) {
  if (!tests) return 'e2e produced no JSON report (run Playwright with --reporter=list,json)';
  const bad = tests.find((t) => t.outcome === 'failed');
  if (bad) return `e2e test failed: ${bad.title}`;
  for (const id of plannedE2e(state)) {
    if (!tests.some((t) => (t.outcome === 'passed' || t.outcome === 'flaky') && t.ids.includes(id))) {
      return `e2e has no passing test for planned scenario ${id}`;
    }
  }
  return null;
}

export function e2eSummary(tests) {
  const rows = tests.map((t) => `| ${t.ids.join(', ') || '-'} | ${t.title} | ${t.outcome} |`);
  const flaky = tests.filter((t) => t.outcome === 'flaky').length;
  return [
    '# E2E results',
    '',
    '| Ids | Test | Outcome |',
    '| --- | --- | --- |',
    ...rows,
    '',
    `${tests.length} tests, ${flaky} flaky (passed only on retry).`,
    '',
  ].join('\n');
}
