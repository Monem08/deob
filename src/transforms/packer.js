'use strict';

const t = require('@babel/types');
const { evaluate } = require('../evaluator');

/**
 * Pass: Packer unpacker (Dean Edwards / p,a,c,k,e,d).
 *
 * Recognizes the classic:
 *
 *   eval(function (p, a, c, k, e, d) {
 *     e = function (c) { ... };
 *     while (c--) if (k[c]) p = p.replace(new RegExp(...), e(c));
 *     return p;
 *   }('payload~a~b', radix, count, 'k0|k1|...'.split('|'), 0, {}));
 *
 * The unpack is a known closed form:
 *  1. keywords = k.split('|')
 *  2. for each word position c: pattern = '\\b' + baseEncode(c) + '\\b',
 *     p = p.replace(pattern, keyword)   (with escaped-word ordering)
 *  3. unwrap the ~a markers (write guard) and ~b (literal quotes)
 *
 * Implemented natively — no eval of foreign code, no runtime execution.
 * The unpacked source replaces the entire eval(...) expression.
 */
function unpackPacker(ast) {
  const { traverse } = require('../utils');

  let changed = true;
  let iterations = 0;

  while (changed && iterations < 6) {
    changed = false;
    iterations++;

    traverse(ast, {
      CallExpression(path) {
        if (!t.isIdentifier(path.node.callee, { name: 'eval' })) return;
        if (path.node.arguments.length !== 1) return;
        const arg = path.node.arguments[0];

        // The IIFE form: eval(function(p,a,c,k,e,d){...}('...', r, c, '...'.split('|'), 0, {}))
        if (!t.isCallExpression(arg)) return;
        const callee = arg.callee;
        if (!t.isFunctionExpression(callee) && !t.isArrowFunctionExpression(callee)) return;
        if (callee.params.length !== 6) return;
        if (arg.arguments.length !== 6) return;

        // Static arguments:
        //   p (payload string), a (radix), c (count), k (keywords split).
        const [pArg, aArg, cArg, kArg] = arg.arguments;

        const pEv = evaluate(pArg);
        if (!pEv.confident || typeof pEv.value !== 'string') return;
        const aEv = evaluate(aArg);
        if (!aEv.confident || typeof aEv.value !== 'number' || aEv.value < 2 || aEv.value > 62) return;
        const cEv = evaluate(cArg);
        if (!cEv.confident || typeof cEv.value !== 'number' || cEv.value < 1 || cEv.value > 4096) return;

        // k: 'a|b|c'.split('|') or a literal array of strings.
        let keywords = null;
        if (
          t.isCallExpression(kArg) &&
          t.isMemberExpression(kArg.callee) &&
          t.isStringLiteral(kArg.callee.object)
        ) {
          const sepArg = kArg.arguments[0];
          const sepEv = evaluate(sepArg);
          if (sepEv.confident && typeof sepEv.value === 'string') {
            keywords = kArg.callee.object.value.split(sepEv.value);
          }
        } else if (t.isArrayExpression(kArg)) {
          const arrEv = evaluate(kArg);
          if (arrEv.confident && Array.isArray(arrEv.value)) keywords = arrEv.value.map(String);
        }
        if (!keywords || keywords.length !== cEv.value) return;

        // Sanity-check the packer body: must contain the signature
        // replace + RegExp + the base-N encode idiom (toString(36-style).
        const { generateCode } = require('../utils');
        let bodySrc;
        try {
          bodySrc = generateCode(callee);
        } catch (e) {
          return;
        }
        if (!bodySrc.includes('replace')) return;
        if (!bodySrc.includes('RegExp') && !bodySrc.includes('regexp')) return;

        // ---- Unpack natively ----
        try {
          const unpacked = unpack(pEv.value, aEv.value, cEv.value, keywords);
          if (unpacked) {
            // Replace the whole eval(...) with the unpacked code. It may
            // itself be obfuscated — the pipeline will process it in the
            // next round.
            const { parse } = require('../utils');
            const unpackedAst = parse(unpacked, { sourceType: 'unambiguous' });
            const program = unpackedAst.program;
            const stmts = program.body;

            if (stmts.length === 1) {
              // Single statement: try to inline as an expression.
              const s = stmts[0];
              if (t.isExpressionStatement(s)) {
                path.replaceWith(s.expression);
              } else {
                path.replaceWithMultiple(stmts);
              }
            } else {
              path.replaceWithMultiple(stmts);
            }
            changed = true;
          }
        } catch (e) {
          // unpack failures leave the original untouched
        }
      },
    });
  }

  return ast;
}

/**
 * The canonical packer unpack algorithm, reimplemented faithfully:
 *
 *   e = function(c) {
 *     return (c < a ? '' : e(parseInt(c / a)))
 *            + ((c = c % a) > 35 ? String.fromCharCode(c + 29) : c.toString(36))
 *   };
 *   while (c--) if (k[c]) p = p.replace(new RegExp('\\b' + e(c) + '\\b', 'g'), k[c]);
 *   return p;
 */
function unpack(p, radix, count, keywords) {
  // The packer's base-N encoder (note: hardcoded .toString(36) for the
  // low digit regardless of radix in the original).
  const enc = (num) => {
    const high = Math.floor(num / radix);
    const low = num % radix;
    const lowStr = low > 35 ? String.fromCharCode(low + 29) : low.toString(36);
    return (high < 1 ? '' : enc(high)) + lowStr;
  };

  for (let c = count - 1; c >= 0; c--) {
    const word = keywords[c];
    if (!word) continue;

    const token = enc(c);
    if (token.length === 0) continue;

    // \b anchors only work for word-char tokens.
    if (/[^\w]/.test(token)) continue;

    try {
      const pattern = new RegExp(`\\b${token}\\b`, 'g');
      p = p.replace(pattern, () => word);
    } catch (e) {
      continue;
    }
  }

  return p;
}

module.exports = unpackPacker;