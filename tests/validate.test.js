'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidPackageName, nameError, isValidDistTag, validateManifest,
} = require('../src/validate');

test('valid names', () => {
  assert.equal(isValidPackageName('reglite'), true);
  assert.equal(isValidPackageName('my-cool-pkg'), true);
  assert.equal(isValidPackageName('@acme/utils'), true);
  assert.equal(isValidPackageName('a1.b2'), true);
});

test('invalid names are rejected with a reason', () => {
  assert.equal(isValidPackageName('MyPkg'), false);
  assert.equal(isValidPackageName('has space'), false);
  assert.equal(isValidPackageName('.hidden'), false);
  assert.equal(isValidPackageName('_private'), false);
  assert.equal(isValidPackageName('@scope'), false);
  assert.equal(isValidPackageName('a'.repeat(215)), false);
  assert.equal(isValidPackageName(''), false);
  assert.equal(nameError('MyPkg'), 'name must be lowercase');
  assert.equal(nameError(''), 'name must be a non-empty string');
});

test('dist-tags', () => {
  assert.equal(isValidDistTag('latest'), true);
  assert.equal(isValidDistTag('beta'), true);
  assert.equal(isValidDistTag('v1 release'), false);
  assert.equal(isValidDistTag(''), false);
});

test('validateManifest catches bad manifests', () => {
  assert.deepEqual(validateManifest({ name: 'ok', version: '1.0.0' }), []);
  assert.equal(validateManifest({ name: 'Bad Name', version: '1.0.0' }).length, 1);
  assert.equal(validateManifest({ name: 'ok', version: '1.0' }).length, 1);
  assert.equal(validateManifest(null).length, 1);
  assert.equal(validateManifest({ name: 'ok', version: '1.0.0', dependencies: [] }).length, 1);
});
