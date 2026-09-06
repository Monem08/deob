'use strict';

const t = require('@babel/types');

/**
 * Pass: Mojibake / UTF-8 byte-string fixer.
 *
 * Obfuscators sometimes encode non-ASCII text as raw UTF-8 bytes inside
 * string literals (e.g. '\xf0\x9f\x91\xbf' for the 👿 emoji). At runtime
 * this renders as mojibake. This pass detects strings whose code units are
 * all in the 0-255 range and form a valid UTF-8 byte sequence, then decodes
 * them back to the intended characters.
 */
function fixMojibake(ast) {
  const { traverse } = require('../utils');

  let changed = true;
  let iterations = 0;

  while (changed && iterations < 20) {
    changed = false;
    iterations++;

    traverse(ast, {
      StringLiteral(path) {
        const raw = path.node.value;
        if (typeof raw !== 'string' || raw.length === 0) return;

        // Only consider strings that are pure Latin-1 (all code units <= 0xFF).
        // If the string already contains surrogate pairs (proper Unicode),
        // skip it — re-encoding would corrupt it.
        let hasHighByte = false;
        for (let i = 0; i < raw.length; i++) {
          const code = raw.charCodeAt(i);
          if (code > 0xff) return; // already proper Unicode, skip
          if (code > 0x7f) hasHighByte = true;
        }
        if (!hasHighByte) return;

        // Convert code units to bytes.
        const bytes = Buffer.from(raw, 'latin1');

        // Validate as UTF-8.
        if (!isValidUtf8(bytes)) return;

        const decoded = bytes.toString('utf8');
        if (decoded === raw) return;

        path.replaceWith(t.stringLiteral(decoded));
        changed = true;
      },
    });
  }

  return ast;
}

/**
 * Check whether a Buffer is a valid UTF-8 byte sequence.
 */
function isValidUtf8(buf) {
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b < 0x80) {
      i += 1;
    } else if ((b & 0xe0) === 0xc0) {
      if (i + 1 >= buf.length) return false;
      if ((buf[i + 1] & 0xc0) !== 0x80) return false;
      i += 2;
    } else if ((b & 0xf0) === 0xe0) {
      if (i + 2 >= buf.length) return false;
      if ((buf[i + 1] & 0xc0) !== 0x80) return false;
      if ((buf[i + 2] & 0xc0) !== 0x80) return false;
      i += 3;
    } else if ((b & 0xf8) === 0xf0) {
      if (i + 3 >= buf.length) return false;
      if ((buf[i + 1] & 0xc0) !== 0x80) return false;
      if ((buf[i + 2] & 0xc0) !== 0x80) return false;
      if ((buf[i + 3] & 0xc0) !== 0x80) return false;
      i += 4;
    } else {
      return false;
    }
  }
  return true;
}

module.exports = fixMojibake;
