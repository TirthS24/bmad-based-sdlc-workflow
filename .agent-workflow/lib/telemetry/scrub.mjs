// PII/PHI scrubber. Best effort: it lowers risk, it cannot prove absence. Extra patterns and
// disabled categories come from .agent-workflow/scrub-patterns.json.
import fs from 'node:fs';
import path from 'node:path';
import { WF_DIR } from '../paths.mjs';

// `group` set: only that capture group is replaced (the value after a label).
export const DEFAULT_PATTERNS = [
  { category: 'email', regex: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}' },
  { category: 'ssn', regex: '\\b\\d{3}[- ]\\d{2}[- ]\\d{4}\\b' },
  { category: 'card', regex: '\\b\\d{4}[ -]\\d{4}[ -]\\d{4}[ -]\\d{4}\\b' },
  { category: 'phone', regex: '(?:\\+\\d{1,3}[\\s.-]?)?(?:\\(\\d{3}\\)|\\b\\d{3})[\\s.-]?\\d{3}[\\s.-]?\\d{4}\\b' },
  {
    category: 'dob',
    regex: '\\b(?:dob|d\\.o\\.b\\.?|date of birth|birth ?date|born)\\b\\W{0,3}(\\d{1,4}[-/.]\\d{1,2}[-/.]\\d{1,4}|[A-Za-z]{3,9}\\.? \\d{1,2},? \\d{4})',
    flags: 'i',
    group: 1,
  },
  {
    category: 'name',
    // Case-sensitive on purpose: the value must look like a capitalised name, not any word.
    regex: '\\b(?:[Pp]atient|[Cc]lient|[Cc]ustomer|[Mm]ember|[Nn]ame)(?: [Nn]ame)?\\s*[:=]\\s*([A-Z][a-z\'-]+(?: [A-Z][a-z\'-]+){0,3})',
    group: 1,
  },
  {
    category: 'account',
    regex: '\\b(?:acct|account|invoice|inv|policy|claim|mrn|member)\\s*(?:no\\.?|number|#|id)?\\s*[:=#]?\\s*((?=[A-Z0-9-]*\\d)[A-Z0-9-]{5,})',
    flags: 'i',
    group: 1,
  },
];

export function loadPatterns() {
  let extra = {};
  try { extra = JSON.parse(fs.readFileSync(path.join(WF_DIR, 'scrub-patterns.json'), 'utf8')); } catch { /* none */ }
  const off = new Set(extra.disable || []);
  return [...DEFAULT_PATTERNS.filter((p) => !off.has(p.category)), ...(extra.patterns || [])]
    .map((p) => ({ ...p, re: new RegExp(p.regex, `${(p.flags || '').replace('g', '')}g`) }));
}

export function scrubText(text, patterns = loadPatterns()) {
  const hits = {};
  let out = String(text);
  for (const p of patterns) {
    out = out.replace(p.re, (...m) => {
      hits[p.category] = (hits[p.category] || 0) + 1;
      if (!p.group) return `[REDACTED:${p.category}]`;
      const whole = m[0];
      const value = m[p.group];
      return whole.slice(0, whole.lastIndexOf(value)) + `[REDACTED:${p.category}]`;
    });
  }
  return { text: out, hits };
}

// Scrubs every string inside a JSON-like value. Returns the clean copy and the hit counts.
export function scrubValue(value, patterns = loadPatterns()) {
  const hits = {};
  const merge = (h) => { for (const [k, v] of Object.entries(h)) hits[k] = (hits[k] || 0) + v; };
  const walk = (v) => {
    if (typeof v === 'string') { const r = scrubText(v, patterns); merge(r.hits); return r.text; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value), hits };
}
