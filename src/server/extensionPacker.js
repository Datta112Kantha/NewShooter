'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

let cachedZip = null;
let lastMtime = 0;

/**
 * Recursively find all files in a directory, ignoring hidden files.
 */
function walkDir(currentDir, relDir = '') {
  const results = [];
  if (!fs.existsSync(currentDir)) return results;

  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'Thumbs.db') continue;
    const fullPath = path.join(currentDir, entry.name);
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, relPath));
    } else if (entry.isFile()) {
      results.push({ fullPath, relPath: relPath.replace(/\\/g, '/') });
    }
  }
  return results;
}

/**
 * Calculate the latest mtime among all files in the directory.
 */
function getLatestMtime(files) {
  let maxTime = 0;
  for (const f of files) {
    try {
      const stat = fs.statSync(f.fullPath);
      if (stat.mtimeMs > maxTime) maxTime = stat.mtimeMs;
    } catch {}
  }
  return maxTime;
}

/**
 * Builds a valid ZIP archive Buffer containing all files from sourceDir.
 * All paths inside the archive are relative to sourceDir (e.g. manifest.json at root).
 */
function buildExtensionZip(sourceDir) {
  const files = walkDir(sourceDir);
  if (files.length === 0) {
    throw new Error(`No files found to pack in ${sourceDir}`);
  }

  const latest = getLatestMtime(files);
  if (cachedZip && latest === lastMtime) {
    return cachedZip;
  }

  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  // Use a fixed or realistic date for reproducible compression
  const dateObj = new Date(latest || Date.now());
  const dosTime =
    ((dateObj.getHours() & 0x1f) << 11) |
    ((dateObj.getMinutes() & 0x3f) << 5) |
    ((Math.floor(dateObj.getSeconds() / 2)) & 0x1f);
  const dosDate =
    (((dateObj.getFullYear() - 1980) & 0x7f) << 9) |
    (((dateObj.getMonth() + 1) & 0x0f) << 5) |
    (dateObj.getDate() & 0x1f);

  for (const file of files) {
    const raw = fs.readFileSync(file.fullPath);
    const compressed = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);
    const nameBuf = Buffer.from(file.relPath, 'utf8');

    // Local file header: 30 bytes + filename
    const lfh = Buffer.alloc(30 + nameBuf.length);
    lfh.writeUInt32LE(0x04034b50, 0); // Local file header signature
    lfh.writeUInt16LE(20, 4);          // Minimum version (2.0)
    lfh.writeUInt16LE(0x0800, 6);      // General purpose bit flag: UTF-8 bit 11
    lfh.writeUInt16LE(8, 8);           // Compression: Deflate
    lfh.writeUInt16LE(dosTime, 10);    // File last modification time
    lfh.writeUInt16LE(dosDate, 12);    // File last modification date
    lfh.writeUInt32LE(crc, 14);        // CRC-32
    lfh.writeUInt32LE(compressed.length, 18); // Compressed size
    lfh.writeUInt32LE(raw.length, 22);        // Uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);    // Filename length
    lfh.writeUInt16LE(0, 28);                 // Extra field length
    nameBuf.copy(lfh, 30);

    localHeaders.push(lfh, compressed);

    // Central directory header: 46 bytes + filename
    const cdh = Buffer.alloc(46 + nameBuf.length);
    cdh.writeUInt32LE(0x02014b50, 0); // Central directory header signature
    cdh.writeUInt16LE(20, 4);          // Version made by
    cdh.writeUInt16LE(20, 6);          // Version needed to extract
    cdh.writeUInt16LE(0x0800, 8);      // UTF-8 flag
    cdh.writeUInt16LE(8, 10);          // Deflate
    cdh.writeUInt16LE(dosTime, 12);
    cdh.writeUInt16LE(dosDate, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(compressed.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);          // Extra field length
    cdh.writeUInt16LE(0, 32);          // File comment length
    cdh.writeUInt16LE(0, 34);          // Disk number start
    cdh.writeUInt16LE(0, 36);          // Internal file attributes
    cdh.writeUInt32LE(0, 38);          // External file attributes
    cdh.writeUInt32LE(offset, 42);     // Relative offset of local header
    nameBuf.copy(cdh, 46);

    centralHeaders.push(cdh);
    offset += lfh.length + compressed.length;
  }

  const centralDirOffset = offset;
  const centralDirSize = centralHeaders.reduce((sum, b) => sum + b.length, 0);

  // End of Central Directory Record: 22 bytes
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);   // EOCD signature
  eocd.writeUInt16LE(0, 4);            // Number of this disk
  eocd.writeUInt16LE(0, 6);            // Disk where central directory starts
  eocd.writeUInt16LE(files.length, 8); // Number of central directory records on this disk
  eocd.writeUInt16LE(files.length, 10);// Total number of central directory records
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20);           // Comment length

  const zipBuffer = Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
  cachedZip = zipBuffer;
  lastMtime = latest;
  return zipBuffer;
}

module.exports = {
  buildExtensionZip,
  walkDir
};
