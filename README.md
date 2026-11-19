# RegLite — a tiny local npm registry

RegLite is a zero-dependency npm registry you can run on your own machine:
publish packages to it, install them from it, and move dist-tags around —
the same workflow npm gives you, without an account or a network.

It exists because the interesting parts of a registry are small and worth
understanding: the metadata document ("packument"), the publish format,
semver resolution, and the tarball format. Everything here is hand-rolled
on the Node standard library so the whole system fits in your head.

## What it does

- **Server** — an npm-compatible registry API: publish (npm-style JSON
  bodies with base64 tarball attachments), metadata documents, tarball
  downloads, dist-tags, and an optional bearer token for publishes.
- **Semver engine** — full SemVer 2.0.0 precedence plus range resolution
  (`^`, `~`, `>=`, `<`, `*`, x-ranges, `||` unions) with npm's rule that
  prereleases only match ranges that mention one.
- **Store** — package metadata as JSON files and tarballs on disk, with
  atomic writes and SHA-1/SHA-512 integrity hashes. Published versions
  are never overwritten, like npm.
- **Tar** — a minimal ustar reader/writer (regular files, checksum
  verification, long-path prefix support) so publish → install
  round-trips through a real tarball.
- **CLI** — `serve`, `publish`, `install` (recursive dependency
  resolution into `node_modules`), `view`, `tag`, `login`.

## Quick start

```bash
# Start a registry (data lives in ./reglite-data)
node cli/reglite.js serve --port 4873

# In another terminal, publish a package from its directory
cd my-package
node /path/to/reglite/cli/reglite.js publish --registry http://localhost:4873

# Install it somewhere else (dependencies resolve recursively)
node /path/to/reglite/cli/reglite.js install my-package@^1.0.0 --registry http://localhost:4873

# Look at it
node /path/to/reglite/cli/reglite.js view my-package --registry http://localhost:4873

# Point a dist-tag at a version
node /path/to/reglite/cli/reglite.js tag my-package stable 1.0.0 --registry http://localhost:4873
```

Lock the registry down with a token — publishes then need
`Authorization: Bearer <token>` (reads stay public):

```bash
node cli/reglite.js serve --port 4873 --token my-secret
node cli/reglite.js login --registry http://localhost:4873   # saves the token to ~/.reglite/config.json
```

Or install it globally and use the `reglite` command:

```bash
npm link   # from this directory
reglite serve
```

## How it works

```
reglite-data/
  packages/<encoded-name>/metadata.json   # the packument: versions + dist-tags
  tarballs/<name>-<version>.tgz          # published tarball bytes
```

Key design decisions:

1. **npm's own publish shape, not a custom one.** The server accepts the
   same JSON body npm sends (`_attachments` with a base64 tarball), so
   any tool that can publish to npm can publish here, and the CLI is
   just a thin client over that format.
2. **The store never overwrites a published version.** A duplicate
   publish is a `409`, mirroring npm's immutability guarantee. Atomic
   renames mean a crashed publish can't corrupt metadata.
3. **Scoped names are stored flat.** `@scope/name` becomes one
   `encodeURIComponent` directory (`%40scope%2Fname`), so the on-disk
   layout never needs nested directories — while the HTTP routes accept
   both `/@scope/name` and `/@scope%2Fname`.
4. **No dependencies at all.** The semver engine, tar handling, HTTP
   server and CLI are all standard library, which keeps `npm install`
   of RegLite itself instant and the codebase auditable.
5. **Installs resolve ranges, not just tags.** `install pkg@^1.2.0`
   picks the highest published version satisfying the range, then
   recurses into that version's dependencies, installing each
   `name@version` once.

## API reference

| Method | Route | Description |
| ------ | ----- | ----------- |
| `GET` | `/` | Server info + package count |
| `GET` | `/-/all` | List of package names |
| `GET` | `/:pkg` | Full metadata document |
| `GET` | `/:pkg/:version` | Single version entry |
| `GET` | `/:pkg/-/:file.tgz` | Tarball bytes |
| `PUT` | `/:pkg` | Publish (npm-style JSON body) |
| `PUT` | `/:pkg/-/tag/:tag` | Set a dist-tag, body `{ "version": "x.y.z" }` |

Errors are JSON `{ "error": "..." }` with the right status: `400` bad
input, `401` missing token, `404` unknown package/version, `409`
duplicate version.

## Running tests

```bash
npm test
```

34 tests with Node's built-in runner — semver precedence and ranges,
store invariants, the HTTP API (including scoped names and auth),
tar round-trips and corruption detection, the client against a live
in-process server, and the CLI itself spawned as a subprocess.

## Tech stack

- **Language:** JavaScript (Node 18+, CommonJS)
- **Runtime:** Node's `http`, `fs`, `crypto` — no third-party packages
- **Tests:** `node:test` + `node:assert/strict`

## Limitations (by design)

- No upstream proxying or caching — this is a local registry, not a mirror.
- No user accounts — one shared bearer token guards publishes.
- No search index — `/-/all` lists names; use `view` for details.
- Tar support covers regular files only (no symlinks, no devices).

## License

MIT — see [LICENSE](LICENSE).
