'use strict';

/**
 * Registry client used by the CLI: publish a directory, view metadata,
 * and install a package (with its dependencies, recursively) from a
 * RegLite server. Speaks the same npm-style JSON the server accepts.
 */

const fs = require('fs');
const path = require('path');
const tar = require('./tar');
const { validateManifest } = require('./validate');
const { maxSatisfying } = require('./semver');

const SKIP_DIRS = new Set(['node_modules', '.git']);
const SKIP_FILES = new Set(['.DS_Store']);

class RegistryError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class RegistryClient {
  constructor(baseUrl, token = null) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  headers(extra = {}) {
    const headers = { ...extra };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  async request(pathname, options = {}) {
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      ...options,
      headers: this.headers(options.headers),
    });
    return res;
  }

  async requestJson(pathname, options = {}) {
    const res = await this.request(pathname, options);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* non-JSON error body */ }
    if (!res.ok) {
      throw new RegistryError(res.status, (body && body.error) || text || `request failed: ${res.status}`);
    }
    return body;
  }

  /** Full metadata document for a package. */
  async getMetadata(name) {
    return this.requestJson(`/${encodeURIComponent(name).replace(/%2F/g, '/')}`);
  }

  /** Resolve a spec (tag or range) to a concrete version. */
  async resolve(name, spec = 'latest') {
    const doc = await this.getMetadata(name);
    if (doc['dist-tags'][spec]) return doc['dist-tags'][spec];
    const version = maxSatisfying(Object.keys(doc.versions), spec);
    if (!version) throw new RegistryError(404, `no version of ${name} satisfies ${spec}`);
    return version;
  }

  async downloadTarball(tarballUrl) {
    const res = await this.request(tarballUrl.replace(this.baseUrl, ''));
    if (!res.ok) throw new RegistryError(res.status, `tarball download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Publish the package in `dir` (must contain package.json).
   * Returns the server's response.
   */
  async publish(dir, tag = 'latest') {
    const manifestPath = path.join(dir, 'package.json');
    if (!fs.existsSync(manifestPath)) throw new Error(`no package.json in ${dir}`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const errors = validateManifest(manifest);
    if (errors.length) throw new Error(`invalid package.json: ${errors.join('; ')}`);
    const files = collectFiles(dir).map((file) => ({
      name: `package/${path.relative(dir, file)}`,
      content: fs.readFileSync(file),
    }));
    const tarball = tar.create(files);
    const body = {
      ...manifest,
      'dist-tags': { [tag]: manifest.version },
      _attachments: {
        [`${manifest.name}-${manifest.version}.tgz`]: {
          content_type: 'application/octet-stream',
          data: tarball.toString('base64'),
        },
      },
    };
    return this.requestJson(
      `/${encodeURIComponent(manifest.name).replace(/%2F/g, '/')}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  }

  /** Set a dist-tag. */
  async setTag(name, tag, version) {
    return this.requestJson(
      `/${encodeURIComponent(name).replace(/%2F/g, '/')}/-/tag/${encodeURIComponent(tag)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version }),
      },
    );
  }

  /**
   * Install a package and its dependencies into `destDir/node_modules`,
   * following the registry's metadata. `installed` tracks name@version
   * pairs already placed, so shared/cyclic dependencies install once.
   * Returns the list of installed name@version pairs.
   */
  async install(name, spec = 'latest', destDir = process.cwd(), installed = new Map()) {
    const version = await this.resolve(name, spec);
    const key = `${name}@${version}`;
    if (installed.has(key)) return [];
    installed.set(key, true);
    const doc = await this.getMetadata(name);
    const entry = doc.versions[version];
    if (!entry) throw new RegistryError(404, `version not found: ${key}`);
    const tarball = await this.downloadTarball(entry.dist.tarball);
    const target = path.join(destDir, 'node_modules', ...name.split('/'));
    fs.mkdirSync(target, { recursive: true });
    for (const file of tar.extract(tarball)) {
      const rel = file.name.replace(/^package\//, '');
      const out = path.join(target, rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, file.content);
    }
    const done = [key];
    const deps = entry.dependencies || {};
    for (const [depName, depRange] of Object.entries(deps)) {
      done.push(...(await this.install(depName, depRange, destDir, installed)));
    }
    return done;
  }
}

/** All publishable files under a directory, skipping junk. */
function collectFiles(dir) {
  const out = [];
  (function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (SKIP_FILES.has(entry.name) || entry.name.endsWith('.tgz')) continue;
        out.push(full);
      }
    }
  })(dir);
  return out.sort();
}

module.exports = { RegistryClient, RegistryError, collectFiles };
