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

export function expandWritePatterns(patterns, config) {
  const out = [];
  for (const p of patterns) {
    if (p === '<test_globs>' || p === '!<test_globs>') {
      const neg = p.startsWith('!');
      for (const g of config.test_globs || []) out.push(neg ? `!${g}` : g);
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
