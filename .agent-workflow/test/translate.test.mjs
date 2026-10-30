// Stage 10: the Claude Code installer translates agent frontmatter into tool lists.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { translateAgent } from '../../installer/install.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = (name) => fs.readFileSync(path.join(ROOT, '.cursor', 'agents', `${name}.md`), 'utf8');
const toolsOf = (text) => /^tools:\s*(.*)$/m.exec(text)?.[1] ?? null;

test('a read-only agent becomes a read-only tool list with no write or shell tool', () => {
  const out = translateAgent(source('requirements-griller'), 'requirements-griller');
  assert.equal(toolsOf(out), 'Read, Grep, Glob');
  assert.doesNotMatch(out, /^readonly:/m);
  assert.doesNotMatch(toolsOf(out), /Write|Edit|Bash/);
  assert.match(out, /Return \*\*only\*\* a JSON array/, 'the body is kept');
});

test('a writer keeps Write and Edit but not Bash', () => {
  const out = translateAgent(source('code-reviewer'), 'code-reviewer');
  assert.equal(toolsOf(out), 'Read, Write, Edit, Grep, Glob');
  assert.doesNotMatch(toolsOf(out), /Bash/);
});

test('the ingestor and synthesizer keep MCP access (no blanket allowlist)', () => {
  const ingestor = translateAgent(source('requirements-ingestor'), 'requirements-ingestor');
  assert.match(ingestor, /^disallowedTools: Bash$/m);
  assert.equal(toolsOf(ingestor), null);
  const synth = translateAgent(source('requirements-synthesizer'), 'requirements-synthesizer');
  assert.match(synth, /^disallowedTools: Write, Edit, NotebookEdit, Bash$/m);
});

test('agents not listed (the implementer) pass through unchanged', () => {
  const text = source('implementer');
  assert.equal(translateAgent(text, 'implementer'), text);
});
