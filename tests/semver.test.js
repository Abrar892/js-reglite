'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parse, isValid, compareVersions, sortVersions, maxVersion, satisfies, maxSatisfying,
} = require('../src/semver');

test('parse accepts full semver and rejects garbage', () => {
  assert.deepEqual(parse('1.2.3').major, 1);
  assert.deepEqual(parse('1.2.3-alpha.1').prerelease, ['alpha', 1]);
  assert.equal(parse('1.2'), null);
  assert.equal(parse('v1.2.3'), null);
  assert.equal(parse('1.2.3.4'), null);
  assert.equal(parse(''), null);
  assert.equal(parse(42), null);
});

test('compare follows semver precedence incl. prereleases', () => {
  assert.equal(compareVersions('1.0.0', '2.0.0'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1);
  assert.equal(compareVersions('1.0.0-alpha.beta', '1.0.0-beta'), -1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.11'), -1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0+build.1', '1.0.0+build.2'), 0);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
});

test('sortVersions and maxVersion', () => {
  assert.deepEqual(sortVersions(['1.0.0', '0.9.9', '1.10.0', '1.2.0']), ['0.9.9', '1.0.0', '1.2.0', '1.10.0']);
  assert.equal(maxVersion(['1.0.0', '2.0.0-beta.1', '1.5.0']), '2.0.0-beta.1');
  assert.equal(maxVersion([]), null);
});

test('satisfies: exact, caret, tilde and comparators', () => {
  assert.equal(satisfies('1.2.3', '1.2.3'), true);
  assert.equal(satisfies('1.2.4', '1.2.3'), false);
  assert.equal(satisfies('1.2.9', '^1.2.3'), true);
  assert.equal(satisfies('2.0.0', '^1.2.3'), false);
  assert.equal(satisfies('0.2.9', '^0.2.3'), true);
  assert.equal(satisfies('0.3.0', '^0.2.3'), false);
  assert.equal(satisfies('1.2.9', '~1.2.3'), true);
  assert.equal(satisfies('1.3.0', '~1.2.3'), false);
  assert.equal(satisfies('1.5.0', '>=1.2.3 <2.0.0'), true);
  assert.equal(satisfies('2.0.0', '>=1.2.3 <2.0.0'), false);
  assert.equal(satisfies('3.0.0', '*'), true);
  assert.equal(satisfies('3.0.0', ''), true);
});

test('satisfies: unions, x-ranges and prerelease rule', () => {
  assert.equal(satisfies('1.0.0', '^1.0.0 || ^2.0.0'), true);
  assert.equal(satisfies('2.1.0', '^1.0.0 || ^2.0.0'), true);
  assert.equal(satisfies('3.0.0', '^1.0.0 || ^2.0.0'), false);
  assert.equal(satisfies('1.2.9', '1.2.x'), true);
  assert.equal(satisfies('1.3.0', '1.2.x'), false);
  assert.equal(satisfies('1.0.0-beta.1', '^1.0.0'), false);
  assert.equal(satisfies('1.0.0-beta.1', '^1.0.0-beta.1'), true);
});

test('maxSatisfying picks the highest match', () => {
  assert.equal(maxSatisfying(['1.0.0', '1.2.0', '2.0.0'], '^1.0.0'), '1.2.0');
  assert.equal(maxSatisfying(['1.0.0', '1.2.0'], '^3.0.0'), null);
  assert.equal(isValid('1.0.0'), true);
  assert.equal(isValid('1.0'), false);
});
