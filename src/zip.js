'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');

/**
 * Zip auto-decoder.
 *
 * Detects whether the input is a ZIP archive. If it is:
 *   1. Extracts it to a temp directory.
 *   2. Recursively processes any nested archives.
 *   3. Finds all .js/.mjs/.cjs/.jsx/.ts files.
 *   4. Deobfuscates each one, preserving the original structure in the
 *      output directory.
 *
 * Returns null when the input is not a ZIP archive.
 */
function tryProcessZip(inputFile, deobfuscate, outputDir) {
  if (!isZipFile(inputFile)) return null;

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deob-zip-'));
  const processed = [];

  try {
    processArchive(inputFile, tmpRoot, deobfuscate, processed, 0);
  } finally {
    // Best-effort cleanup of the temp extraction tree.
    removeDir(tmpRoot);
  }

  if (outputDir) {
    writeResults(processed, outputDir);
  }

  return processed;
}

function isZipFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    return false;
  }
  if (!stat.isFile()) return false;

  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4);
    const bytes = fs.readSync(fd, buf, 0, 4, 0);
    if (bytes < 4) return false;
    // Local file header magic: PK\x03\x04 (also empty archive PK\x05\x06).
    return (
      (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) ||
      (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x05 && buf[3] === 0x06)
    );
  } finally {
    fs.closeSync(fd);
  }
}

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts']);
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.jar', '.xpi', '.war']);

const MAX_ARCHIVE_DEPTH = 5;
const MAX_TOTAL_FILES = 20000;

let totalFiles = 0;

function processArchive(archiveFile, destDir, deobfuscate, processed, depth) {
  if (depth > MAX_ARCHIVE_DEPTH) return;

  const zip = new AdmZip(archiveFile);
  zip.extractAllTo(destDir, true);

  const entries = walk(destDir);

  for (const absPath of entries) {
    const ext = path.extname(absPath).toLowerCase();

    // Nested archive -> extract and recurse.
    if (ARCHIVE_EXTENSIONS.has(ext) && absPath !== archiveFile) {
      const nestedDir = path.join(destDir, path.basename(absPath) + '-extracted');
      fs.mkdirSync(nestedDir, { recursive: true });
      processArchive(absPath, nestedDir, deobfuscate, processed, depth + 1);
      continue;
    }

    if (!JS_EXTENSIONS.has(ext)) continue;

    totalFiles++;
    if (totalFiles > MAX_TOTAL_FILES) return;

    let code;
    try {
      code = fs.readFileSync(absPath, 'utf8');
    } catch (e) {
      continue;
    }

    let result;
    try {
      result = deobfuscate(code);
    } catch (e) {
      result = code; // keep original on failure
    }

    processed.push({ file: absPath, source: code, result });
  }
}

function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current);
    } catch (e) {
      continue;
    }
    for (const name of entries) {
      const full = path.join(current, name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch (e) {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (stat.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

function writeResults(processed, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });

  for (const item of processed) {
    const rel = path.basename(item.file);
    const outFile = path.join(outputDir, rel);
    fs.writeFileSync(outFile, item.result, 'utf8');
  }
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    // ignore cleanup failures
  }
}

module.exports = { tryProcessZip, isZipFile };