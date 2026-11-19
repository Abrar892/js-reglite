'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PackageStore } = require('../src/store');
const { createServer } = require('../src/server');
const { RegistryClient, RegistryError } = require('../src/client');

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reglite-client-'));
  const store = new PackageStore(dir);
  const server = createServer(store);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, client: new RegistryClient(`http://127.0.0.1:${port}`), dir };
}

function makePackage(dir, name, version, deps = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version, description: `${name} demo`, dependencies: deps }, null, 2),
  );
  fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = '${name}@${version}';\n`);
}

test('publish then install round-trips through the real server', async (t) => {
  const { server, client, dir } = await startServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const pkgDir = path.join(dir, 'pkg-a');
  makePackage(pkgDir, 'pkg-a', '1.0.0');
  const res = await client.publish(pkgDir);
  assert.equal(res.id, 'pkg-a@1.0.0');

  const installDir = path.join(dir, 'app');
  const installed = await client.install('pkg-a', '^1.0.0', installDir);
  assert.deepEqual(installed, ['pkg-a@1.0.0']);
  const installedFile = path.join(installDir, 'node_modules', 'pkg-a', 'index.js');
  assert.equal(fs.readFileSync(installedFile, 'utf8'), "module.exports = 'pkg-a@1.0.0';\n");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(installDir, 'node_modules', 'pkg-a', 'package.json'), 'utf8')).version,
    '1.0.0',
  );
});

test('install resolves dependencies recursively and installs each once', async (t) => {
  const { server, client, dir } = await startServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  makePackage(path.join(dir, 'leaf'), 'leaf', '2.0.0');
  makePackage(path.join(dir, 'mid'), 'mid', '1.0.0', { leaf: '^2.0.0' });
  makePackage(path.join(dir, 'top'), 'top', '1.0.0', { mid: '^1.0.0', leaf: '^2.0.0' });
  await client.publish(path.join(dir, 'leaf'));
  await client.publish(path.join(dir, 'mid'));
  await client.publish(path.join(dir, 'top'));

  const installDir = path.join(dir, 'app');
  const installed = await client.install('top', 'latest', installDir);
  assert.deepEqual([...installed].sort(), ['leaf@2.0.0', 'mid@1.0.0', 'top@1.0.0']);
  for (const name of ['top', 'mid', 'leaf']) {
    assert.ok(fs.existsSync(path.join(installDir, 'node_modules', name, 'index.js')));
  }
});

test('resolve honors tags and ranges; unknown specs fail cleanly', async (t) => {
  const { server, client, dir } = await startServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  makePackage(path.join(dir, 'ver'), 'ver', '1.0.0');
  await client.publish(path.join(dir, 'ver'));
  makePackage(path.join(dir, 'ver2'), 'ver', '2.0.0-beta.1');
  await client.publish(path.join(dir, 'ver2'), 'beta');

  assert.equal(await client.resolve('ver', 'latest'), '1.0.0');
  assert.equal(await client.resolve('ver', 'beta'), '2.0.0-beta.1');
  assert.equal(await client.resolve('ver', '^1.0.0'), '1.0.0');
  await assert.rejects(() => client.resolve('ver', '^3.0.0'), /no version of ver satisfies/);
  await assert.rejects(() => client.resolve('ghost', 'latest'), RegistryError);
});

test('publishing an invalid package is rejected before any network call', async (t) => {
  const { server, client, dir } = await startServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const badDir = path.join(dir, 'bad');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'package.json'), JSON.stringify({ name: 'Bad Name', version: '1.0' }));
  await assert.rejects(() => client.publish(badDir), /invalid package\.json/);
});

test('tagging through the client moves the dist-tag', async (t) => {
  const { server, client, dir } = await startServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  makePackage(path.join(dir, 'tagged'), 'tagged', '1.0.0');
  await client.publish(path.join(dir, 'tagged'));
  const res = await client.setTag('tagged', 'stable', '1.0.0');
  assert.equal(res['dist-tags'].stable, '1.0.0');
  assert.equal(await client.resolve('tagged', 'stable'), '1.0.0');
});
