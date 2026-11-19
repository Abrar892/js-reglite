'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PackageStore } = require('../src/store');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reglite-store-'));
  return { store: new PackageStore(dir), dir };
}

test('publish stores metadata, tarball and dist-tags', () => {
  const { store } = tmpStore();
  const doc = store.publish(
    'my-lib',
    { name: 'my-lib', version: '1.0.0', description: 'demo', dependencies: { lodash: '^4.0.0' } },
    Buffer.from('fake-tarball-bytes'),
  );
  assert.equal(doc['dist-tags'].latest, '1.0.0');
  assert.equal(doc.versions['1.0.0'].dist.shasum.length, 40);
  assert.ok(doc.versions['1.0.0'].dist.integrity.startsWith('sha512-'));
  assert.deepEqual(store.getTarball('my-lib', '1.0.0'), Buffer.from('fake-tarball-bytes'));
  assert.equal(store.latestVersion('my-lib'), '1.0.0');
  assert.deepEqual(store.listPackages(), ['my-lib']);
});

test('publish rejects duplicate versions and mismatched names', () => {
  const { store } = tmpStore();
  store.publish('my-lib', { name: 'my-lib', version: '1.0.0' }, Buffer.from('x'));
  assert.throws(
    () => store.publish('my-lib', { name: 'my-lib', version: '1.0.0' }, Buffer.from('y')),
    /already exists/,
  );
  assert.throws(
    () => store.publish('other', { name: 'my-lib', version: '2.0.0' }, Buffer.from('y')),
    /does not match/,
  );
  assert.throws(
    () => store.publish('bad name', { name: 'bad name', version: '1.0.0' }, Buffer.from('y')),
    /invalid package name/,
  );
  assert.throws(
    () => store.publish('my-lib', { name: 'my-lib', version: '1.0.0' }, Buffer.alloc(0)),
    /tarball is empty/,
  );
});

test('second version updates latest; tags and resolve work', () => {
  const { store } = tmpStore();
  store.publish('my-lib', { name: 'my-lib', version: '1.0.0' }, Buffer.from('a'));
  store.publish('my-lib', { name: 'my-lib', version: '1.1.0' }, Buffer.from('b'));
  assert.equal(store.latestVersion('my-lib'), '1.1.0');
  // Publishing under a non-latest tag must NOT move `latest` (npm semantics).
  store.publish('my-lib', { name: 'my-lib', version: '1.2.0-beta.1' }, Buffer.from('c'), 'beta');
  assert.equal(store.latestVersion('my-lib'), '1.1.0');
  assert.equal(store.resolve('my-lib', 'beta'), '1.2.0-beta.1');
  assert.equal(store.resolve('my-lib', '^1.0.0'), '1.1.0');
  assert.equal(store.resolve('my-lib', '1.0.0'), '1.0.0');
  assert.equal(store.resolve('my-lib', '^2.0.0'), null);
  assert.equal(store.resolve('nope', '*'), null);
  store.setTag('my-lib', 'stable', '1.0.0');
  assert.equal(store.resolve('my-lib', 'stable'), '1.0.0');
  assert.throws(() => store.setTag('my-lib', 'x', '9.9.9'), /unknown version/);
});

test('scoped names are stored flat and round-trip', () => {
  const { store, dir } = tmpStore();
  store.publish('@acme/utils', { name: '@acme/utils', version: '0.1.0' }, Buffer.from('z'));
  assert.deepEqual(store.listPackages(), ['@acme/utils']);
  assert.ok(fs.existsSync(path.join(dir, 'packages', '%40acme%2Futils', 'metadata.json')));
  assert.equal(store.getPackage('@acme/utils').name, '@acme/utils');
});
