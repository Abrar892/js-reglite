'use strict';

/**
 * Validation for npm package names, versions and dist-tags, following the
 * rules npm itself enforces on publish (lowercase, URL-safe, <= 214 chars,
 * no leading dot/underscore, scoped names as @scope/name).
 */

const { isValid: isValidVersion } = require('./semver');

const MAX_NAME_LENGTH = 214;
// Unscoped: lowercase letters, digits, -, ~ and . (not leading), no spaces.
const UNSCOPED_RE = /^(?![._])[a-z0-9-~]+(?:\.[a-z0-9-~]+)*$/;
// Scoped: @scope/name where each part follows the same rules.
const SCOPED_RE = /^@(?![._])[a-z0-9-~]+(?:\.[a-z0-9-~]+)*\/(?![._])[a-z0-9-~]+(?:\.[a-z0-9-~]+)*$/;
// A dist-tag is a non-empty string without whitespace or URL-unsafe chars.
const TAG_RE = /^[^\s/:*?"<>|]+$/;

function isValidPackageName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.length > MAX_NAME_LENGTH) return false;
  if (name !== name.toLowerCase()) return false;
  if (name.startsWith('@')) return SCOPED_RE.test(name);
  return UNSCOPED_RE.test(name);
}

/** Human-readable reason a name is invalid, or null when it is valid. */
function nameError(name) {
  if (typeof name !== 'string' || name.length === 0) return 'name must be a non-empty string';
  if (name.length > MAX_NAME_LENGTH) return `name must be ${MAX_NAME_LENGTH} characters or fewer`;
  if (name !== name.toLowerCase()) return 'name must be lowercase';
  if (/[^a-z0-9\-~.@/]/.test(name)) return 'name must be URL-safe (no spaces or special characters)';
  if (name.startsWith('.') || name.startsWith('_')) return 'name must not start with . or _';
  if (name.startsWith('@') && !SCOPED_RE.test(name)) return 'scoped name must look like @scope/name';
  if (!name.startsWith('@') && !UNSCOPED_RE.test(name)) return 'name contains invalid characters';
  return null;
}

function isValidDistTag(tag) {
  return typeof tag === 'string' && tag.length > 0 && TAG_RE.test(tag);
}

/** Validate a publish manifest (the package.json of the version being published). */
function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') return ['manifest must be an object'];
  if (!isValidPackageName(manifest.name)) {
    errors.push(`invalid package name: ${JSON.stringify(manifest.name)} (${nameError(manifest.name)})`);
  }
  if (!isValidVersion(manifest.version)) {
    errors.push(`invalid version: ${JSON.stringify(manifest.version)}`);
  }
  if (manifest.dependencies !== undefined
    && (typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies))) {
    errors.push('dependencies must be an object');
  }
  return errors;
}

module.exports = {
  isValidPackageName,
  nameError,
  isValidDistTag,
  isValidVersion,
  validateManifest,
  MAX_NAME_LENGTH,
};
