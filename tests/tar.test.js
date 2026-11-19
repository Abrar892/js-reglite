'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create, extract, list } = require('../src/tar');

test('create/extract round-trips files, including empty and binary', () => {
  const files = [
    { name: 'package/package.json', content: '{"name":"demo"}' },
    { name: 'package/index.js', content: 'module.exports = 42;\n' },
    { name: 'package/empty.txt', content: '' },
    { name: 'package/blob.bin', content: Buffer.from([0, 1, 2, 255, 254, 0]) },
  ];
  const tarball = create(files);
  assert.equal(tarball.length % 512, 0);
  const entries = extract(tarball);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries.map((e) => e.name), files.map((f) => f.name));
  assert.equal(entries[0].content.toString(), '{"name":"demo"}');
  assert.equal(entries[2].content.length, 0);
  assert.deepEqual(entries[3].content, Buffer.from([0, 1, 2, 255, 254, 0]));
});

test('list returns names and sizes without content copies', () => {
  const tarball = create([
    { name: 'a.txt', content: 'hello' },
    { name: 'b.txt', content: 'x'.repeat(600) },
  ]);
  assert.deepEqual(list(tarball), [
    { name: 'a.txt', size: 5 },
    { name: 'b.txt', size: 600 },
  ]);
});

test('long paths use the ustar prefix field and survive', () => {
  const longName = `package/${'deep/'.repeat(18)}file.js`; // 113 chars
  assert.ok(longName.length > 100);
  const entries = extract(create([{ name: longName, content: 'ok' }]));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, longName);
});

test('a corrupted checksum is rejected', () => {
  const tarball = create([{ name: 'a.txt', content: 'hello' }]);
  const corrupt = Buffer.from(tarball);
  corrupt[100] = (corrupt[100] + 1) % 256; // damage the mode field
  assert.throws(() => extract(corrupt), /checksum mismatch/);
});

test('a truncated tarball is rejected', () => {
  const tarball = create([{ name: 'a.txt', content: 'hello world' }]);
  // Cut inside the file data itself (header is 512 bytes, data is 11).
  assert.throws(() => extract(tarball.subarray(0, 520)), /truncated/);
});

test('empty file list makes an end-marker-only tarball', () => {
  const entries = extract(create([]));
  assert.deepEqual(entries, []);
});
