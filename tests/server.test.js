'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PackageStore } = require('../src/store');
const { createServer } = require('../src/server');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reglite-server-'));
  return new PackageStore(dir);
}

/** Start a server on an ephemeral port; returns { server, base }. */
async function start(store, options) {
  const server = createServer(store, options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

async function stop(server) {
  await new Promise((resolve) => server.close(resolve));
}

function publishBody(name, version, tag = 'latest') {
  return {
    name,
    version,
    description: 'test package',
    dependencies: {},
    'dist-tags': { [tag]: version },
    _attachments: {
      [`${name}-${version}.tgz`]: {
        content_type: 'application/octet-stream',
        data: Buffer.from(`tarball-${name}-${version}`).toString('base64'),
      },
    },
  };
}

test('full publish -> metadata -> tarball round trip', async (t) => {
  const store = tmpStore();
  const { server, base } = await start(store);
  t.after(() => stop(server));

  const pub = await fetch(`${base}/my-lib`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(publishBody('my-lib', '1.0.0')),
  });
  assert.equal(pub.status, 201);
  assert.deepEqual((await pub.json())['dist-tags'], { latest: '1.0.0' });

  const meta = await fetch(`${base}/my-lib`);
  assert.equal(meta.status, 200);
  const doc = await meta.json();
  assert.equal(doc.versions['1.0.0'].version, '1.0.0');
  assert.match(doc.versions['1.0.0'].dist.tarball, /^http:\/\/127\.0\.0\.1:\d+\/my-lib\/-\/my-lib-1\.0\.0\.tgz$/);

  const tgz = await fetch(doc.versions['1.0.0'].dist.tarball);
  assert.equal(tgz.status, 200);
  assert.equal(await tgz.text(), 'tarball-my-lib-1.0.0');

  const single = await fetch(`${base}/my-lib/1.0.0`);
  assert.equal(single.status, 200);
  assert.equal((await single.json()).version, '1.0.0');
});

test('duplicate publish is a 409 and bad publishes are 400s', async (t) => {
  const store = tmpStore();
  const { server, base } = await start(store);
  t.after(() => stop(server));

  const body = publishBody('dup-lib', '1.0.0');
  assert.equal((await fetch(`${base}/dup-lib`, { method: 'PUT', body: JSON.stringify(body) })).status, 201);
  const again = await fetch(`${base}/dup-lib`, { method: 'PUT', body: JSON.stringify(body) });
  assert.equal(again.status, 409);
  assert.match((await again.json()).error, /already exists/);

  const noAttach = await fetch(`${base}/dup-lib`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'dup-lib', version: '2.0.0' }),
  });
  assert.equal(noAttach.status, 400);

  const badName = await fetch(`${base}/Bad Name`, {
    method: 'PUT',
    body: JSON.stringify(publishBody('Bad Name', '1.0.0')),
  });
  assert.equal(badName.status, 400);
});

test('unknown packages and versions are 404s; /-/all lists names', async (t) => {
  const store = tmpStore();
  const { server, base } = await start(store);
  t.after(() => stop(server));

  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/nope/1.0.0`)).status, 404);
  assert.equal((await fetch(`${base}/nope/-/nope-1.0.0.tgz`)).status, 404);

  await fetch(`${base}/alpha`, { method: 'PUT', body: JSON.stringify(publishBody('alpha', '0.1.0')) });
  await fetch(`${base}/beta`, { method: 'PUT', body: JSON.stringify(publishBody('beta', '0.1.0')) });
  const all = await (await fetch(`${base}/-/all`)).json();
  assert.deepEqual(all.packages, ['alpha', 'beta']);
});

test('dist-tag endpoint moves tags; scoped names work end to end', async (t) => {
  const store = tmpStore();
  const { server, base } = await start(store);
  t.after(() => stop(server));

  await fetch(`${base}/@acme%2Futils`, { method: 'PUT', body: JSON.stringify(publishBody('@acme/utils', '1.0.0')) });
  await fetch(`${base}/@acme%2Futils`, { method: 'PUT', body: JSON.stringify(publishBody('@acme/utils', '1.1.0')) });
  const tag = await fetch(`${base}/@acme%2Futils/-/tag/stable`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: '1.0.0' }),
  });
  assert.equal(tag.status, 200);
  assert.deepEqual((await tag.json())['dist-tags'], { latest: '1.1.0', stable: '1.0.0' });

  const meta = await (await fetch(`${base}/@acme%2Futils`)).json();
  assert.equal(meta.versions['1.0.0'].dist.tarball.includes('/@acme/utils/-/'), true);
  const tgz = await fetch(meta.versions['1.0.0'].dist.tarball);
  assert.equal(await tgz.text(), 'tarball-@acme/utils-1.0.0');

  const badTag = await fetch(`${base}/@acme%2Futils/-/tag/stable`, {
    method: 'PUT',
    body: JSON.stringify({ version: '9.9.9' }),
  });
  assert.equal(badTag.status, 404);
});

test('bearer token guards publishes but not reads', async (t) => {
  const store = tmpStore();
  const { server, base } = await start(store, { token: 'secret-token' });
  t.after(() => stop(server));

  const denied = await fetch(`${base}/secure-lib`, {
    method: 'PUT',
    body: JSON.stringify(publishBody('secure-lib', '1.0.0')),
  });
  assert.equal(denied.status, 401);

  const allowed = await fetch(`${base}/secure-lib`, {
    method: 'PUT',
    headers: { authorization: 'Bearer secret-token' },
    body: JSON.stringify(publishBody('secure-lib', '1.0.0')),
  });
  assert.equal(allowed.status, 201);

  const read = await fetch(`${base}/secure-lib`);
  assert.equal(read.status, 200);
});

test('server info reports package count', async (t) => {
  const store = tmpStore();
  const { server, base } = await start(store);
  t.after(() => stop(server));
  const info = await (await fetch(base)).json();
  assert.equal(info.name, 'reglite');
  assert.equal(info.packages, 0);
});
