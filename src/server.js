'use strict';

/**
 * RegLite HTTP registry API — a small npm-compatible surface:
 *
 *   GET  /                        server info
 *   GET  /-/all                  list of package names
 *   GET  /:pkg                   full metadata document (npm "packument")
 *   GET  /:pkg/:version          single version entry
 *   GET  /:pkg/-/:file.tgz       tarball bytes
 *   PUT  /:pkg                   publish (npm-style JSON body with _attachments)
 *   PUT  /:pkg/-/tag/:tag        set a dist-tag  { "version": "1.2.3" }
 *
 * Publish bodies follow npm's own shape:
 *   { "name", "version", "dist-tags": { "latest": "1.0.0" },
 *     "_attachments": { "name-1.0.0.tgz": { "data": "<base64>" } } }
 *
 * Auth: when the server is started with a token, every PUT needs
 * `Authorization: Bearer <token>`. Reads stay public, like a real registry.
 */

const http = require('http');
const { PackageStore } = require('./store');
const { isValidPackageName, isValidDistTag } = require('./validate');
const { isValid: isValidVersion } = require('./semver');

const MAX_BODY_BYTES = 50 * 1024 * 1024; // 50 MB tarballs are plenty for local use

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Split a request path into raw (still-encoded) segments, dropping empty ones. */
function segments(pathname) {
  return pathname.split('/').filter(Boolean);
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * A package name occupies one segment, or two when scoped (@scope/name).
 * Scoped names may arrive as one encoded segment (@scope%2Fname) or two
 * plain ones (@scope/name) — both are accepted. Each segment is decoded
 * individually so an encoded slash inside a tarball filename stays one
 * segment. Returns { name, rest } or null when the path cannot start
 * with a name.
 */
function parsePackagePath(parts) {
  if (parts.length === 0) return null;
  const first = safeDecode(parts[0]);
  const rest = parts.slice(1).map(safeDecode);
  if (first.startsWith('@')) {
    if (first.includes('/')) return { name: first, rest };
    if (parts.length < 2) return null;
    return { name: `${first}/${safeDecode(parts[1])}`, rest: parts.slice(2).map(safeDecode) };
  }
  return { name: first, rest };
}

function createServer(store, options = {}) {
  const token = options.token || null;
  const version = options.version || '1.0.0';

  function tarballUrl(req, name, file) {
    const host = req.headers.host || 'localhost';
    const proto = req.socket.encrypted ? 'https' : 'http';
    // Package part keeps npm's /@scope/name shape; the file part stays
    // URL-encoded so a scoped name cannot split into extra segments.
    return `${proto}://${host}/${name}/-/${file}`;
  }

  function withTarballUrls(req, doc) {
    const copy = JSON.parse(JSON.stringify(doc));
    for (const entry of Object.values(copy.versions)) {
      const file = entry.dist.tarball;
      entry.dist.tarball = tarballUrl(req, copy.name, file);
    }
    return copy;
  }

  function authorized(req) {
    if (!token) return true;
    const header = req.headers.authorization || '';
    return header === `Bearer ${token}`;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = segments(url.pathname);

      if (req.method === 'GET' && parts.length === 0) {
        return sendJson(res, 200, { name: 'reglite', version, packages: store.listPackages().length });
      }

      if (req.method === 'GET' && parts.length === 2 && parts[0] === '-' && parts[1] === 'all') {
        return sendJson(res, 200, { packages: store.listPackages() });
      }

      const pkg = parsePackagePath(parts);
      if (!pkg) return sendError(res, 404, 'not found');
      const { name, rest } = pkg;
      if (!isValidPackageName(name)) return sendError(res, 400, `invalid package name: ${name}`);

      // GET /:pkg/-/:file.tgz — tarball download. The decoded file segment
      // is always `<name>-<version>.tgz`, so the version is unambiguous.
      if (req.method === 'GET' && rest.length === 2 && rest[0] === '-') {
        const file = rest[1];
        if (!file.endsWith('.tgz') || !file.startsWith(`${name}-`)) {
          return sendError(res, 404, `tarball not found: ${name} ${file}`);
        }
        const version = file.slice(name.length + 1, -'.tgz'.length);
        const tarball = store.getTarball(name, version);
        if (!tarball) return sendError(res, 404, `tarball not found: ${name}@${version}`);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': tarball.length,
        });
        return res.end(tarball);
      }

      // GET /:pkg/:version — single version entry
      if (req.method === 'GET' && rest.length === 1 && rest[0] !== '-') {
        const doc = store.getPackage(name);
        if (!doc) return sendError(res, 404, `package not found: ${name}`);
        const entry = doc.versions[rest[0]];
        if (!entry) return sendError(res, 404, `version not found: ${name}@${rest[0]}`);
        const copy = JSON.parse(JSON.stringify(entry));
        copy.dist.tarball = tarballUrl(req, name, copy.dist.tarball);
        return sendJson(res, 200, copy);
      }

      // GET /:pkg — full metadata document
      if (req.method === 'GET' && rest.length === 0) {
        const doc = store.getPackage(name);
        if (!doc) return sendError(res, 404, `package not found: ${name}`);
        return sendJson(res, 200, withTarballUrls(req, doc));
      }

      // PUT /:pkg/-/tag/:tag — set a dist-tag
      if (req.method === 'PUT' && rest.length === 3 && rest[0] === '-' && rest[1] === 'tag') {
        if (!authorized(req)) return sendError(res, 401, 'missing or invalid bearer token');
        const tag = rest[2];
        if (!isValidDistTag(tag)) return sendError(res, 400, `invalid dist-tag: ${tag}`);
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const versionToTag = typeof body === 'string' ? body : body.version;
        if (!isValidVersion(versionToTag)) return sendError(res, 400, 'body must be { "version": "x.y.z" }');
        try {
          const doc = store.setTag(name, tag, versionToTag);
          return sendJson(res, 200, { ok: true, 'dist-tags': doc['dist-tags'] });
        } catch (err) {
          return sendError(res, 404, err.message);
        }
      }

      // PUT /:pkg — publish (npm-style JSON body with _attachments)
      if (req.method === 'PUT' && rest.length === 0) {
        if (!authorized(req)) return sendError(res, 401, 'missing or invalid bearer token');
        let body;
        try {
          body = JSON.parse((await readBody(req)).toString('utf8'));
        } catch {
          return sendError(res, 400, 'publish body must be valid JSON');
        }
        const attachments = body._attachments || {};
        const files = Object.keys(attachments);
        if (files.length === 0) return sendError(res, 400, 'publish body needs _attachments with the tarball');
        const data = attachments[files[0]].data;
        if (typeof data !== 'string') return sendError(res, 400, 'tarball attachment must be base64 data');
        const tarball = Buffer.from(data, 'base64');
        const tag = (body['dist-tags'] && Object.keys(body['dist-tags'])[0]) || 'latest';
        try {
          const doc = store.publish(name, body, tarball, tag);
          return sendJson(res, 201, { ok: true, id: `${name}@${body.version}`, 'dist-tags': doc['dist-tags'] });
        } catch (err) {
          const status = /already exists/.test(err.message) ? 409 : 400;
          return sendError(res, status, err.message);
        }
      }

      return sendError(res, 404, 'not found');
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  });

  return server;
}

module.exports = { createServer, PackageStore, MAX_BODY_BYTES };
