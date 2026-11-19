'use strict';

/**
 * Minimal ustar tar reader/writer — just enough for npm-style package
 * tarballs (regular files only). Zero dependencies; the registry and the
 * CLI both use it, so publish -> install round-trips through one format.
 *
 * Layout of a 512-byte header block (offsets are octal in the format):
 *   name 0-100, mode 100-108, uid 108-116, gid 116-124, size 124-136,
 *   mtime 136-148, chksum 148-156, typeflag 156, magic 257-263 ("ustar"),
 *   prefix 345-500 (holds the leading part of names over 100 chars).
 */

const BLOCK = 512;

function writeOctal(buf, offset, length, value) {
  const octal = value.toString(8);
  // Null-terminated octal, right-aligned, zero-padded.
  const field = '0'.repeat(Math.max(0, length - octal.length - 1)) + octal;
  buf.write(field, offset, length - 1, 'ascii');
  buf[offset + length - 1] = 0;
}

function readOctal(buf, offset, length) {
  const raw = buf.toString('ascii', offset, offset + length).replace(/\0.*$/, '').trim();
  if (raw === '') return 0;
  const n = parseInt(raw, 8);
  return Number.isNaN(n) ? 0 : n;
}

function writeString(buf, offset, length, value) {
  buf.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8');
}

/** Split a long path into ustar prefix + name (split on a '/' boundary). */
function splitName(name) {
  if (Buffer.byteLength(name) <= 100) return { prefix: '', name };
  const idx = name.lastIndexOf('/', 100);
  if (idx === -1 || idx > 155) throw new Error(`path too long for tar header: ${name}`);
  return { prefix: name.slice(0, idx), name: name.slice(idx + 1) };
}

/** Build one header block for a regular file. */
function headerBlock(name, size, mtime) {
  const { prefix, name: shortName } = splitName(name);
  const header = Buffer.alloc(BLOCK);
  writeString(header, 0, 100, shortName);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor((mtime ?? Date.now()) / 1000));
  header.fill(0x20, 148, 156); // checksum field is spaces while computing
  header[156] = '0'.charCodeAt(0); // regular file
  writeString(header, 257, 6, 'ustar');
  writeString(header, 263, 2, '00');
  writeString(header, 345, 155, prefix);
  let sum = 0;
  for (const byte of header) sum += byte;
  writeOctal(header, 148, 8, sum);
  return header;
}

/**
 * Pack files into a tarball Buffer.
 * @param {{name:string, content:Buffer|string, mtime?:number}[]} files
 */
function create(files) {
  const chunks = [];
  for (const file of files) {
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content);
    chunks.push(headerBlock(file.name, content.length, file.mtime));
    chunks.push(content);
    const pad = (BLOCK - (content.length % BLOCK)) % BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(BLOCK * 2)); // end-of-archive marker
  return Buffer.concat(chunks);
}

/**
 * Parse a tarball into entries. Throws on a bad checksum or truncation.
 * @returns {{name:string, size:number, content:Buffer, mtime:number}[]}
 */
function extract(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const stored = readOctal(header, 148, 8);
    const check = Buffer.from(header);
    check.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of check) sum += byte;
    if (sum !== stored) throw new Error(`tar checksum mismatch at offset ${offset}`);
    const typeflag = String.fromCharCode(header[156]);
    if (typeflag !== '0' && typeflag !== '\0') {
      throw new Error(`unsupported tar entry type ${JSON.stringify(typeflag)}`);
    }
    let name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    if (prefix) name = `${prefix}/${name}`;
    const size = readOctal(header, 124, 12);
    const mtime = readOctal(header, 136, 12) * 1000;
    const start = offset + BLOCK;
    const end = start + size;
    if (end > buffer.length) throw new Error('truncated tarball');
    entries.push({ name, size, content: Buffer.from(buffer.subarray(start, end)), mtime });
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}

/** Names and sizes only, without copying file contents. */
function list(buffer) {
  return extract(buffer).map(({ name, size }) => ({ name, size }));
}

module.exports = { create, extract, list, BLOCK };
