'use strict';

/**
 * Minimal semver implementation (SemVer 2.0.0 precedence + a practical
 * subset of npm range syntax): exact, ^, ~, >=, <=, >, <, *, x-ranges
 * and `||` unions. No dependencies.
 */

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Parse a version string. Returns null when invalid.
 * @returns {{major:number, minor:number, patch:number, prerelease:(string|number)[], raw:string}|null}
 */
function parse(version) {
  if (typeof version !== 'string') return null;
  const m = SEMVER_RE.exec(version.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4]
      ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p))
      : [],
    raw: version.trim(),
  };
}

function isValid(version) {
  return parse(version) !== null;
}

/** Compare two parsed versions. -1, 0 or 1. Build metadata is ignored. */
function compare(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  const pa = a.prerelease;
  const pb = b.prerelease;
  if (pa.length === 0 && pb.length === 0) return 0;
  if (pa.length === 0) return 1; // release > prerelease
  if (pb.length === 0) return -1;
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    if (i >= pa.length) return -1; // shorter prerelease < longer
    if (i >= pb.length) return 1;
    const x = pa[i];
    const y = pb[i];
    if (x === y) continue;
    const xn = typeof x === 'number';
    const yn = typeof y === 'number';
    if (xn && yn) return x < y ? -1 : 1;
    if (xn) return -1; // numeric < alphanumeric
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function compareVersions(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) throw new Error(`invalid version: ${!pa ? a : b}`);
  return compare(pa, pb);
}

/** Sort versions ascending (semver precedence). Returns a new array. */
function sortVersions(versions) {
  return [...versions].sort(compareVersions);
}

/** Highest version in the list, or null for an empty list. */
function maxVersion(versions) {
  const sorted = sortVersions(versions.filter((v) => isValid(v)));
  return sorted.length ? sorted[sorted.length - 1] : null;
}

/** Expand one comparator token (e.g. "^1.2.3", "~1.2", ">=1.0.0") into [op, version] bounds. */
function expandComparator(token) {
  const t = token.trim();
  if (t === '' || t === '*' || t.toLowerCase() === 'x') return null; // matches everything
  const m = /^([~^<>=]*)\s*(.+)$/.exec(t);
  if (!m) throw new Error(`invalid range token: ${token}`);
  const op = m[1] || '=';
  const raw = m[2].trim();
  const partial = raw.split('.');
  const nums = partial.map((p) => (/^\d+$/.test(p) ? Number(p) : null));
  if (nums.some((n) => n === null) && !/^\d+\.\d+\.\d+/.test(raw)) {
    // x-range like 1.2.x / 1.x — treat missing parts as wildcards
    const major = nums[0];
    const minor = nums[1];
    if (major === null || major === undefined) return null;
    if (minor === null || minor === undefined) {
      return { op: 'range', lo: `${major}.0.0`, hi: `${major + 1}.0.0` };
    }
    return { op: 'range', lo: `${major}.${minor}.0`, hi: `${major}.${minor + 1}.0` };
  }
  const parsed = parse(raw);
  if (!parsed) throw new Error(`invalid version in range: ${raw}`);
  const { major, minor, patch } = parsed;
  // Keep the full version (including any prerelease) as the lower bound,
  // otherwise ^1.0.0-beta.1 could never match 1.0.0-beta.1 itself.
  const base = parsed.raw;
  if (op === '^') {
    let hi;
    if (major > 0) hi = `${major + 1}.0.0`;
    else if (minor > 0) hi = `0.${minor + 1}.0`;
    else hi = `0.0.${patch + 1}`;
    return { op: 'range', lo: base, hi };
  }
  if (op === '~') {
    return { op: 'range', lo: base, hi: `${major}.${minor + 1}.0` };
  }
  return { op, version: base };
}

function testComparator(version, comp) {
  if (comp === null) return true; // wildcard
  const c = compareVersions(version, comp.version ?? comp.lo);
  if (comp.op === 'range') {
    return c >= 0 && compareVersions(version, comp.hi) < 0;
  }
  switch (comp.op) {
    case '=': return c === 0;
    case '>': return c > 0;
    case '>=': return c >= 0;
    case '<': return c < 0;
    case '<=': return c <= 0;
    default: throw new Error(`unknown operator: ${comp.op}`);
  }
}

/**
 * Does `version` satisfy `range`?
 * Range grammar: space-separated AND comparators, `||` for OR unions,
 * `*` / empty for any version. Prereleases only match when the range
 * itself mentions a prerelease (npm's rule).
 */
function satisfies(version, range) {
  const parsed = parse(version);
  if (!parsed) return false;
  const rawRange = String(range ?? '').trim();
  if (rawRange === '' || rawRange === '*' || rawRange.toLowerCase() === 'latest') return true;
  const hasPrereleaseInRange = /-/.test(rawRange);
  if (parsed.prerelease.length > 0 && !hasPrereleaseInRange) return false;
  return rawRange.split('||').some((unionPart) => {
    const tokens = unionPart.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return true;
    return tokens.every((token) => testComparator(version, expandComparator(token)));
  });
}

/** Highest version satisfying `range`, or null. */
function maxSatisfying(versions, range) {
  const matching = versions.filter((v) => satisfies(v, range));
  return maxVersion(matching);
}

module.exports = {
  parse,
  isValid,
  compare,
  compareVersions,
  sortVersions,
  maxVersion,
  satisfies,
  maxSatisfying,
};
