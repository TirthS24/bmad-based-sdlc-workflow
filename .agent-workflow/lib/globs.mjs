// Glob matching for stage write permissions and frozen test globs. Pure functions.

export function globToRegExp(glob) {
  const g = glob.replace(/\\/g, '/');
  let out = '';
  for (let i = 0; i < g.length; i += 1) {
    if (g.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 2;
      continue;
    }
    if (g.startsWith('**', i)) {
      out += '.*';
      i += 1;
      continue;
    }
    if (g[i] === '*') {
      out += '[^/]*';
      continue;
    }
    if (/[.+^${}()|[\]\\]/.test(g[i])) out += `\\${g[i]}`;
    else out += g[i];
  }
  return new RegExp(`^${out}$`);
}

// Product (flow) tests are frozen at gate_tests; unit tests belong to the implementer.
// Configs from before the split only have test_globs, which then means product tests.
export const productGlobs = (config) => config.product_test_globs ?? config.test_globs ?? [];
export const unitGlobs = (config) => config.unit_test_globs ?? [];

export function expandWritePatterns(patterns, config, runId = '') {
  const out = [];
  const sets = {
    src_globs: config.src_globs || [],
    docs_globs: config.docs_globs || [],
    test_globs: productGlobs(config),
    product_test_globs: productGlobs(config),
    unit_test_globs: unitGlobs(config),
  };
  for (const p of patterns) {
    const token = /^(!?)<(test_globs|product_test_globs|unit_test_globs|src_globs|docs_globs)>$/.exec(p);
    if (token) {
      for (const g of sets[token[2]]) out.push(`${token[1]}${g}`);
    } else if (p === '<run_dir>') {
      out.push(`.agent-workflow/runs/${runId}/**`);
    } else {
      out.push(p);
    }
  }
  return out;
}

export function matchesGlob(rel, glob) {
  const r = rel.replace(/^\.\//, '');
  const re = globToRegExp(glob);
  if (re.test(r)) return true;
  if (glob.endsWith('/**') && (r === glob.slice(0, -3) || r.startsWith(glob.slice(0, -2)))) {
    return true;
  }
  return false;
}

export function writesAllowed(rel, allowPatterns) {
  let allowed = false;
  for (const p of allowPatterns) {
    const negated = p.startsWith('!');
    const g = negated ? p.slice(1) : p;
    if (matchesGlob(rel, g)) allowed = !negated;
  }
  return allowed;
}

export function matchesAnyGlob(rel, globs) {
  return (globs || []).some((g) => matchesGlob(rel, g));
}
