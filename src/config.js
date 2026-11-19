'use strict';

/**
 * ~/.reglite/config.json — where the CLI keeps the registry URL and the
 * publish token from `reglite login`. Permissions are tightened to 0600
 * because the file holds a credential.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function configPath() {
  return process.env.REGLITE_CONFIG || path.join(os.homedir(), '.reglite', 'config.json');
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function save(config) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function getRegistry(cliValue) {
  return cliValue || load().registry || 'http://localhost:4873';
}

function getToken() {
  return load().token || process.env.REGLITE_TOKEN || null;
}

module.exports = { configPath, load, save, getRegistry, getToken };
