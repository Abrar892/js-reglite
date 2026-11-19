#!/usr/bin/env node
'use strict';

/**
 * reglite — CLI for the RegLite local npm registry.
 *
 *   reglite serve [--port 4873] [--data ./reglite-data] [--token TOKEN]
 *   reglite publish [--tag latest] [--registry URL]
 *   reglite install <name>[@<range>] [--registry URL] [--dir .]
 *   reglite view <name>[@<version-or-range>]
 *   reglite tag <name> <tag> <version>
 *   reglite login [--registry URL]
 */

const path = require('path');
const readline = require('readline');
const { PackageStore } = require('../src/store');
const { createServer } = require('../src/server');
const { RegistryClient, RegistryError } = require('../src/client');
const config = require('../src/config');
const { maxSatisfying } = require('../src/semver');

const VERSION = '1.0.0';

function usage() {
  console.log(`RegLite ${VERSION} — a tiny local npm registry

Usage:
  reglite serve [--port 4873] [--data ./reglite-data] [--token TOKEN]
      Start the registry server (data lives in --data).
  reglite publish [--tag latest] [--registry URL] [--dir .]
      Publish the package in the given directory (default: current).
  reglite install <name>[@<range>] [--registry URL] [--dir .]
      Install a package and its dependencies into <dir>/node_modules.
  reglite view <name>[@<version-or-range>] [--registry URL]
      Show a package's versions, dist-tags and dependencies.
  reglite tag <name> <tag> <version> [--registry URL]
      Point a dist-tag at a published version.
  reglite login [--registry URL]
      Save a publish token for the registry.

Options:
  --registry URL   Registry to talk to (default: saved value or http://localhost:4873)
  --help, -h       Show this help
  --version, -v    Show the version`);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (const ch of arg.slice(1)) flags[ch] = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exitCode = 1;
}

function clientFrom(flags) {
  return new RegistryClient(config.getRegistry(flags.registry), config.getToken());
}

/** Split "name@spec" — careful: scoped names start with @. */
function splitNameSpec(input) {
  const at = input.lastIndexOf('@');
  if (at > 0) return { name: input.slice(0, at), spec: input.slice(at + 1) || 'latest' };
  return { name: input, spec: 'latest' };
}

async function cmdServe(flags) {
  const port = Number(flags.port || 4873);
  const dataDir = flags.data || path.join(process.cwd(), 'reglite-data');
  const token = flags.token || process.env.REGLITE_TOKEN || null;
  const store = new PackageStore(dataDir);
  const server = createServer(store, { token, version: VERSION });
  server.listen(port, () => {
    console.log(`RegLite ${VERSION} listening on http://localhost:${port}`);
    console.log(`data: ${dataDir} (${store.listPackages().length} packages)`);
    console.log(token ? 'publishes require a bearer token' : 'publishes are open (no token set)');
  });
}

async function cmdPublish(flags) {
  const client = clientFrom(flags);
  try {
    const res = await client.publish(flags.dir || process.cwd(), flags.tag || 'latest');
    console.log(`published ${res.id} (tag: ${Object.keys(res['dist-tags']).join(', ')})`);
  } catch (err) {
    fail(err instanceof RegistryError ? `${err.status}: ${err.message}` : err.message);
  }
}

async function cmdInstall(positional, flags) {
  if (positional.length === 0) return fail('install needs a package name, e.g. reglite install my-lib@^1.0.0');
  const { name, spec } = splitNameSpec(positional[0]);
  const client = clientFrom(flags);
  try {
    const installed = await client.install(name, spec, flags.dir || process.cwd());
    for (const pkg of installed) console.log(`+ ${pkg}`);
    console.log(`installed ${installed.length} package(s)`);
  } catch (err) {
    fail(err instanceof RegistryError ? `${err.status}: ${err.message}` : err.message);
  }
}

async function cmdView(positional, flags) {
  if (positional.length === 0) return fail('view needs a package name');
  const { name, spec } = splitNameSpec(positional[0]);
  const client = clientFrom(flags);
  try {
    const doc = await client.getMetadata(name);
    const versions = Object.keys(doc.versions);
    console.log(`${doc.name}`);
    console.log(`dist-tags: ${Object.entries(doc['dist-tags']).map(([t, v]) => `${t}: ${v}`).join(', ')}`);
    console.log(`versions: ${versions.join(', ')}`);
    const target = spec === 'latest'
      ? doc['dist-tags'].latest
      : (doc.versions[spec] ? spec : maxSatisfying(versions, spec));
    if (target && doc.versions[target]) {
      const entry = doc.versions[target];
      console.log(`\n${entry.name}@${entry.version}${entry.description ? ` — ${entry.description}` : ''}`);
      const deps = Object.entries(entry.dependencies || {});
      console.log(deps.length ? `dependencies: ${deps.map(([d, r]) => `${d}@${r}`).join(', ')}` : 'dependencies: none');
      console.log(`tarball: ${entry.dist.tarball}`);
    }
  } catch (err) {
    fail(err instanceof RegistryError ? `${err.status}: ${err.message}` : err.message);
  }
}

async function cmdTag(positional, flags) {
  if (positional.length < 3) return fail('usage: reglite tag <name> <tag> <version>');
  const [name, tag, version] = positional;
  const client = clientFrom(flags);
  try {
    const res = await client.setTag(name, tag, version);
    console.log(`tagged ${name}@${version} as ${tag}`);
    console.log(`dist-tags: ${Object.entries(res['dist-tags']).map(([t, v]) => `${t}: ${v}`).join(', ')}`);
  } catch (err) {
    fail(err instanceof RegistryError ? `${err.status}: ${err.message}` : err.message);
  }
}

async function cmdLogin(flags) {
  const registry = config.getRegistry(flags.registry);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const token = await new Promise((resolve) => {
    rl.question(`token for ${registry}: `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
  if (!token) return fail('no token given');
  const current = config.load();
  config.save({ ...current, registry, token });
  console.log(`saved token for ${registry} in ${config.configPath()}`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h) return usage();
  if (flags.version || flags.v) return console.log(VERSION);
  const [command, ...rest] = positional;
  switch (command) {
    case 'serve': return cmdServe(flags);
    case 'publish': return cmdPublish(flags);
    case 'install': return cmdInstall(rest, flags);
    case 'view': return cmdView(rest, flags);
    case 'tag': return cmdTag(rest, flags);
    case 'login': return cmdLogin(flags);
    case undefined: return usage();
    default: return fail(`unknown command: ${command} (try --help)`);
  }
}

main().catch((err) => fail(err.message));
