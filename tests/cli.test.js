'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'cli', 'reglite.js');

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

async function waitForPort(port, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`server did not start on port ${port}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('help and version work; unknown commands fail', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage:/);
  const version = await runCli(['--version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
  const bad = await runCli(['frobnicate']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /unknown command/);
});

test('serve, publish, view, tag and install through the real CLI', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reglite-cli-'));
  const configFile = path.join(dir, 'config.json');
  const env = { REGLITE_CONFIG: configFile };
  const port = 46000 + Math.floor(Math.random() * 2000);
  const registry = `http://127.0.0.1:${port}`;

  const server = spawn(process.execPath, [CLI, 'serve', '--port', String(port), '--data', path.join(dir, 'data')], {
    env: { ...process.env, ...env },
    stdio: 'ignore',
  });
  t.after(() => server.kill());
  await waitForPort(port);

  const pkgDir = path.join(dir, 'my-tool');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'my-tool', version: '1.0.0', description: 'cli test pkg' }),
  );
  fs.writeFileSync(path.join(pkgDir, 'index.js'), "module.exports = 'cli-works';\n");

  const pub = await runCli(['publish', '--registry', registry, '--dir', pkgDir], env);
  assert.equal(pub.code, 0, pub.stderr);
  assert.match(pub.stdout, /published my-tool@1\.0\.0/);

  const view = await runCli(['view', 'my-tool', '--registry', registry], env);
  assert.equal(view.code, 0, view.stderr);
  assert.match(view.stdout, /dist-tags: latest: 1\.0\.0/);
  assert.match(view.stdout, /my-tool@1\.0\.0 — cli test pkg/);

  const tag = await runCli(['tag', 'my-tool', 'stable', '1.0.0', '--registry', registry], env);
  assert.equal(tag.code, 0, tag.stderr);
  assert.match(tag.stdout, /tagged my-tool@1\.0\.0 as stable/);

  const appDir = path.join(dir, 'app');
  const install = await runCli(['install', 'my-tool', '--registry', registry, '--dir', appDir], env);
  assert.equal(install.code, 0, install.stderr);
  assert.match(install.stdout, /\+ my-tool@1\.0\.0/);
  assert.equal(
    fs.readFileSync(path.join(appDir, 'node_modules', 'my-tool', 'index.js'), 'utf8'),
    "module.exports = 'cli-works';\n",
  );

  const missing = await runCli(['view', 'ghost-pkg', '--registry', registry], env);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /404/);
});

test('login saves the token to the config file', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reglite-login-'));
  const configFile = path.join(dir, 'config.json');
  const env = { REGLITE_CONFIG: configFile };
  const proc = spawn(process.execPath, [CLI, 'login', '--registry', 'http://127.0.0.1:4999'], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  const done = new Promise((resolve) => proc.on('close', resolve));
  proc.stdin.write('tok-abc-123\n');
  proc.stdin.end();
  const code = await done;
  assert.equal(code, 0);
  assert.match(stdout, /saved token/);
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(saved.token, 'tok-abc-123');
  assert.equal(saved.registry, 'http://127.0.0.1:4999');
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
});
