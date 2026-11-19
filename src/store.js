'use strict';

/**
 * On-disk store for package metadata and tarballs.
 *
 * Layout under the data directory:
 *   packages/<encoded-name>/metadata.json   full registry document
 *   tarballs/<encoded-name>-<version>.tgz   published tarball bytes
 *
 * Writes are atomic (write to a temp file, then rename) so a crashed
 * publish can never leave a half-written metadata document behind.
 * Scoped names are encoded with encodeURIComponent, so `@scope/name`
 * becomes a single flat directory name.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isValidPackageName, validateManifest } = require('./validate');
const { sortVersions, maxVersion } = require('./semver');

function encodeName(name) {
  return encodeURIComponent(name);
}

function tarballFileName(name, version) {
  return `${encodeName(name)}-${version}.tgz`;
}

class PackageStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.packagesDir = path.join(dataDir, 'packages');
    this.tarballsDir = path.join(dataDir, 'tarballs');
    fs.mkdirSync(this.packagesDir, { recursive: true });
    fs.mkdirSync(this.tarballsDir, { recursive: true });
  }

  metadataPath(name) {
    return path.join(this.packagesDir, encodeName(name), 'metadata.json');
  }

  tarballPath(name, version) {
    return path.join(this.tarballsDir, tarballFileName(name, version));
  }

  /** Full registry document for a package, or null when unknown. */
  getPackage(name) {
    const file = this.metadataPath(name);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  /** Names of every package in the store, sorted. */
  listPackages() {
    if (!fs.existsSync(this.packagesDir)) return [];
    return fs
      .readdirSync(this.packagesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => decodeURIComponent(e.name))
      .sort();
  }

  hasVersion(name, version) {
    const doc = this.getPackage(name);
    return Boolean(doc && doc.versions && doc.versions[version]);
  }

  /**
   * Publish a version. `manifest` is the package.json of the version,
   * `tarball` is a Buffer, `tag` defaults to "latest".
   * Throws on invalid manifest, duplicate version or empty tarball.
   * Returns the updated registry document.
   */
  publish(name, manifest, tarball, tag = 'latest') {
    const errors = validateManifest(manifest);
    if (manifest && manifest.name !== name) {
      errors.push(`manifest name ${JSON.stringify(manifest.name)} does not match URL name ${JSON.stringify(name)}`);
    }
    if (errors.length) throw new Error(`invalid publish: ${errors.join('; ')}`);
    if (!Buffer.isBuffer(tarball) || tarball.length === 0) {
      throw new Error('invalid publish: tarball is empty');
    }
    if (!isValidPackageName(name)) throw new Error(`invalid package name: ${name}`);
    if (this.hasVersion(name, manifest.version)) {
      throw new Error(`version ${manifest.version} of ${name} already exists (npm never overwrites a published version)`);
    }

    const shasum = crypto.createHash('sha1').update(tarball).digest('hex');
    const integrity = `sha512-${crypto.createHash('sha512').update(tarball).digest('base64')}`;

    const doc = this.getPackage(name) || {
      name,
      'dist-tags': {},
      versions: {},
      time: {},
    };
    const versionEntry = {
      name,
      version: manifest.version,
      description: manifest.description || '',
      main: manifest.main,
      dependencies: manifest.dependencies || {},
      dist: {
        shasum,
        integrity,
        tarball: tarballFileName(name, manifest.version),
      },
    };
    doc.versions[manifest.version] = versionEntry;
    doc['dist-tags'][tag] = manifest.version;
    if (!doc['dist-tags'].latest) doc['dist-tags'].latest = manifest.version;
    doc.time[manifest.version] = new Date().toISOString();
    doc.time.modified = new Date().toISOString();
    doc.time.created = doc.time.created || doc.time[manifest.version];

    const dir = path.dirname(this.metadataPath(name));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.tarballPath(name, manifest.version), tarball);
    this.#writeJsonAtomic(this.metadataPath(name), doc);
    return doc;
  }

  /** Set a dist-tag to an existing version. Returns the updated document. */
  setTag(name, tag, version) {
    const doc = this.getPackage(name);
    if (!doc) throw new Error(`unknown package: ${name}`);
    if (!doc.versions[version]) throw new Error(`unknown version: ${name}@${version}`);
    doc['dist-tags'][tag] = version;
    doc.time.modified = new Date().toISOString();
    this.#writeJsonAtomic(this.metadataPath(name), doc);
    return doc;
  }

  /** Tarball bytes for a published version, or null. */
  getTarball(name, version) {
    const file = this.tarballPath(name, version);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file);
  }

  /** Resolve a tag or range to a concrete version, or null. */
  resolve(name, spec) {
    const doc = this.getPackage(name);
    if (!doc) return null;
    const versions = Object.keys(doc.versions);
    if (spec === 'latest' || doc['dist-tags'][spec]) return doc['dist-tags'][spec];
    const { maxSatisfying } = require('./semver');
    return maxSatisfying(versions, spec);
  }

  /** Latest version of a package, or null. */
  latestVersion(name) {
    const doc = this.getPackage(name);
    if (!doc) return null;
    return doc['dist-tags'].latest || maxVersion(Object.keys(doc.versions));
  }

  #writeJsonAtomic(file, value) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  }
}

module.exports = { PackageStore, encodeName, tarballFileName };
