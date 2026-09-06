'use strict';

const t = require('@babel/types');

/**
 * Pass: Identity-pattern resolution.
 *
 * Collapses provably self-cancelling transformation chains:
 *
 * 1. RC4 double-apply: rc4(key, rc4(key, x)) === x  (RC4 is an involution
 *    when applied twice with the same key). Detects the canonical RC4
 *    structure (256-loop KSA + PRGA) and folds double applications.
 *
 * 2. Base64 round trip: b64decode(b64encode(x)) === x. Recognizes common
 *    encode/decode idioms (btoa/atob, Buffer base64, encodeURIComponent
 *    round trips) and collapses encode-then-decode chains regardless of
 *    which spelling of encode/decode the obfuscator used.
 */
function identityResolve(ast) {
  const { traverse } = require('../utils');

  let changed = true;
  let iterations = 0;

  while (changed && iterations < 10) {
    changed = false;
    iterations++;

    traverse(ast, {
      CallExpression(path) {
        const node = path.node;

        // rc4(key, rc4(key, X)) -> X
        if (isRc4Call(node, path) && node.arguments.length === 2) {
          let inner = node.arguments[1];

          // Resolve single-use const intermediates: rc4(k, tmp) where tmp = rc4(k, X).
          if (t.isIdentifier(inner)) {
            const resolved = resolveConstCall(inner, path);
            if (resolved && isRc4Call(resolved, path)) {
              inner = resolved;
              // Collapse the outer call to the inner's data argument.
              if (inner.arguments.length === 2 && nodesEqual(node.arguments[0], inner.arguments[0])) {
                // Inline the inner call into the outer position, then remove decl.
                const declBinding = path.scope.getBinding(t.isIdentifier(node.arguments[1]) ? node.arguments[1].name : null);
                path.replaceWith(t.cloneNode(inner.arguments[1], true));
                if (declBinding && declBinding.path && declBinding.path.isVariableDeclarator()) {
                  const d = declBinding.path.parentPath;
                  if (t.isVariableDeclaration(d.node) && d.node.declarations.length === 1) d.remove();
                  else declBinding.path.remove();
                }
                changed = true;
                return;
              }
            }
          }

          if (t.isCallExpression(inner) && isRc4Call(inner, path) && inner.arguments.length === 2) {
            const outerKey = node.arguments[0];
            const innerKey = inner.arguments[0];
            if (nodesEqual(outerKey, innerKey)) {
              path.replaceWith(t.cloneNode(inner.arguments[1], true));
              changed = true;
              return;
            }
          }
        }

        // decode(encode(X)) -> X
        const outerDec = getB64Meaning(node, 'decode', path);
        if (outerDec) {
          // The decoded input may sit behind a single-use const chain.
          let decInput = node.arguments[0];
          if (outerDec.input) decInput = outerDec.input;

          if (t.isCallExpression(decInput)) {
            const innerEnc = getB64Meaning(decInput, 'encode', path);
            if (innerEnc) {
              const x = innerEnc.input || extractMeaningInput(decInput);
              if (x) {
                path.replaceWith(t.cloneNode(x, true));
                changed = true;
                return;
              }
            }
          }

          // Resolve single-use const holding the encode call.
          if (t.isIdentifier(decInput)) {
            const resolved = resolveConstCall(decInput, path);
            if (resolved) {
              const innerEnc = getB64Meaning(resolved, 'encode', path);
              if (innerEnc) {
                const x = innerEnc.input || extractMeaningInput(resolved);
                if (x && fallbackMatches(outerDec, x, path)) {
                  path.replaceWith(t.cloneNode(x, true));
                  // Remove the now-unused intermediate declaration.
                  const declBinding = path.scope.getBinding(decInput.name);
                  if (declBinding && declBinding.path && declBinding.path.isVariableDeclarator()) {
                    const d = declBinding.path.parentPath;
                    if (t.isVariableDeclaration(d.node) && d.node.declarations.length === 1) d.remove();
                    else declBinding.path.remove();
                  }
                  changed = true;
                  return;
                }
              }
            }
          }
        }

        // utf8Decode(utf8Encode(X)) -> X
        const outerUtf8 = getUtf8Meaning(node, 'decode', path);
        if (outerUtf8) {
          const inner = node.arguments[0];
          if (t.isCallExpression(inner)) {
            const innerUtf8 = getUtf8Meaning(inner, 'encode', path);
            if (innerUtf8) {
              path.replaceWith(t.cloneNode(inner.arguments[0], true));
              changed = true;
              return;
            }
          }
        }
      },
    });
  }

  return ast;
}

/**
 * Structural check: is this call `rc4Like(key, data)` where rc4Like is a
 * const-bound arrow whose body matches the canonical RC4 shape?
 */
function isRc4Call(node, path) {
  if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return false;
  if (!path) return false;

  const binding = path.scope.getBinding(node.callee.name);
  if (!binding || !binding.path || !binding.path.isVariableDeclarator()) return false;

  const init = binding.path.node.init;
  if (!init || !t.isArrowFunctionExpression(init)) return false;
  if (binding.path.parentPath.node.kind !== 'const') return false;
  if (init.params.length !== 2 || !init.params.every((p) => t.isIdentifier(p))) return false;
  if (!t.isBlockStatement(init.body)) return false;

  return looksLikeRc4(init.body, init.params);
}

/**
 * Structural RC4 detection: a function body that contains
 *  - a 256-length s-box init (Array.from({length:256},...) or a for loop to 256),
 *  - a KSA loop (j updated with + s[i] + key.charCodeAt(i % key.length), swaps),
 *  - a PRGA loop (i/j updates, swap, output XOR with s[(s[i]+s[j]) & 255]).
 * Conservative: only matches when every RC4 fingerprint is present.
 */
function looksLikeRc4(body, params) {
  let src;
  try {
    const generate = require('@babel/generator').default;
    src = generate(t.cloneNode(body, true)).code;
  } catch (e) {
    return false;
  }

  const keyName = params[0].name;
  const strName = params[1].name;

  const has256 =
    src.includes('256') ||
    src.includes('255');
  const hasKsaKey = src.includes('charCodeAt');
  const hasModKeyLen = src.includes(`${keyName}.length`);
  const hasSwap = /\]\s*=\s*\[\s*[^\s]*\[/.test(src) || src.includes('] = [');
  const hasXorOut = src.includes('^') && src.includes('fromCharCode');
  const hasAnd255 = src.includes('& 255') || src.includes('&255');
  const usesStr = src.includes(`${strName}.length`) || src.includes(`${strName}.charCodeAt`);

  return has256 && hasKsaKey && hasModKeyLen && hasSwap && hasXorOut && hasAnd255 && usesStr;
}

/**
 * For resilient-decoder meanings: the catch fallback must carry the same
 * value as the encode-side input X — that's what makes the collapse safe
 * (every execution path of the IIFE yields X).
 */
function fallbackMatches(decMeaning, encodeInput, path) {
  if (!decMeaning || !decMeaning.fallback) return true; // no fallback to verify
  const fb = decMeaning.fallback;

  const { evaluate, withScope } = require('../evaluator');
  const scope = path ? path.scope : null;
  const fbEv = withScope(scope, () => evaluate(fb));
  const inEv = withScope(scope, () => evaluate(encodeInput));

  if (fbEv.confident && inEv.confident) {
    return fbEv.value === inEv.value;
  }

  // Fall back to name comparison for unresolvable identifiers.
  return t.isIdentifier(fb) && t.isIdentifier(encodeInput) && fb.name === encodeInput.name;
}

/**
 * Resolve an identifier to the CallExpression its const declaration holds,
 * when it is single-use and const-bound. Returns the call node or null.
 */
function resolveConstCall(ident, path) {
  if (!t.isIdentifier(ident) || !path) return null;
  const binding = path.scope.getBinding(ident.name);
  if (!binding || !binding.path || !binding.path.isVariableDeclarator()) return null;
  if (binding.constantViolations.length > 0) return null;
  if (binding.referencePaths.length > 1) return null;

  const init = binding.path.node.init;
  if (!init || !t.isCallExpression(init)) return null;
  return init;
}

/**
 * Determine the "meaning" of a call for base64 encode/decode idioms.
 * Also resolves const-bound wrapper arrows and typeof-branch IIFEs
 * whose branches all carry the same meaning.
 * Returns { flavor } or null.
 */
function getB64Meaning(node, direction, path) {
  if (!t.isCallExpression(node)) return null;

  // Direct idiom first...
  const direct = getDirectB64Meaning(node, direction);
  if (direct) return direct;

  // Resilient decoder IIFE (try/catch + TextDecoder idiom).
  const resilient = getResilientDecoderMeaning(node, direction, path);
  if (resilient) return resilient;

  // typeof-branch IIFE: (() => { if (typeof btoa === 'function') return btoa(s); return Buffer...; })()
  // When every branch carries the same meaning and takes the same input.
  const iifeMeaning = getIifeBranchMeaning(node, direction, path);
  if (iifeMeaning) return iifeMeaning;

  // ...then look through const-bound wrapper functions.
  if (path && t.isIdentifier(node.callee)) {
    const wrapper = getWrapperBody(node, path);
    if (wrapper) {
      // typeof-branch wrapper: both branches must carry the same meaning.
      if (wrapper.__branches) {
        const meanings = wrapper.__branches.map((b) =>
          t.isCallExpression(b) ? getDirectB64Meaning(b, direction) : null
        );
        if (meanings[0] && meanings[1] && meanings[0].flavor === meanings[1].flavor) {
          return meanings[0];
        }
      } else if (t.isCallExpression(wrapper)) {
        const innerMeaning = getDirectB64Meaning(wrapper, direction);
        if (innerMeaning) return innerMeaning;
        // Recurse one more level for nested wrappers.
        const nested = getB64Meaning(wrapper, direction, null);
        if (nested) return nested;
      }
    }
  }

  return null;
}

/**
 * Match (() => { if (test) return A; return B; })(x) IIFEs where both
 * A and B share the same encode/decode meaning applied to the same value.
 * Returns the shared meaning, with the shared input node attached.
 */
function getIifeBranchMeaning(node, direction, path) {
  const callee = node.callee;
  if (!callee || (!t.isArrowFunctionExpression(callee) && !t.isFunctionExpression(callee))) return null;
  if (node.arguments.length !== 0) return null;

  const body = callee.body;
  if (!t.isBlockStatement(body) || body.body.length !== 2) return null;

  const [ifStmt, retStmt] = body.body;
  if (!t.isIfStatement(ifStmt) || !t.isReturnStatement(retStmt)) return null;
  if (!ifStmt.consequent || !t.isBlockStatement(ifStmt.consequent)) return null;
  if (ifStmt.consequent.body.length !== 1 || !t.isReturnStatement(ifStmt.consequent.body[0])) return null;
  // Alternate is optional — a trailing return often serves as the else.
  let branchC = null;
  if (ifStmt.alternate) {
    if (!t.isBlockStatement(ifStmt.alternate) || ifStmt.alternate.body.length !== 1) return null;
    if (!t.isReturnStatement(ifStmt.alternate.body[0])) return null;
    branchC = ifStmt.alternate.body[0].argument;
  }

  const branchA = ifStmt.consequent.body[0].argument;
  const branchB = retStmt.argument;
  if (!branchA || !branchB) return null;

  const meanings = [branchA, branchB, branchC].filter(Boolean).map((b) =>
    t.isCallExpression(b) ? getDirectB64Meaning(b, direction) : null
  );
  if (meanings.some((m) => !m)) return null;

  // All branches must operate on the same input node.
  const inputs = [branchA, branchB, branchC].filter(Boolean).map((b) => extractMeaningInput(b));
  if (inputs.some((i) => !i)) return null;
  if (!inputs.every((i) => nodesEqualShallow(i, inputs[0]))) return null;

  return { flavor: 'mixed', input: inputs[0] };
}

/**
 * Extract the data input node from a meaning call:
 *   atob(s)                          -> s
 *   btoa(s)                          -> s
 *   Buffer.from(s, 'base64')         -> s
 *   buf.toString('base64')           -> <input of the inner Buffer.from>
 *   Buffer.from(s,'utf8').toString() -> s
 */
function extractMeaningInput(callNode) {
  if (!t.isCallExpression(callNode)) return null;
  const callee = callNode.callee;

  // atob(s) / btoa(s) / escape(s) / decodeURIComponent(s) — direct single-arg.
  if (t.isIdentifier(callee) && callNode.arguments.length === 1) {
    return callNode.arguments[0];
  }

  // Buffer.from(s, enc) — input is the first argument.
  if (
    t.isMemberExpression(callee) &&
    t.isIdentifier(callee.object, { name: 'Buffer' })
  ) {
    return callNode.arguments[0] || null;
  }

  // inner.toString('base64'/'utf8') where inner = Buffer.from(s, enc) —
  // the callee's object is the Buffer.from call itself.
  if (
    t.isMemberExpression(callee) &&
    t.isCallExpression(callee.object)
  ) {
    return callee.object.arguments[0] || null;
  }

  return null;
}

/**
 * Match the common "resilient decoder" IIFE:
 *
 *   (() => {
 *     try {
 *       const bin = <decode>(arg);
 *       if (typeof TextDecoder !== "undefined") {
 *         return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
 *       }
 *       return bin;                 (or decodeURIComponent(escape(bin)))
 *     } catch {
 *       return <arg>;               (fallback to input)
 *     }
 *   })()
 *
 * All paths reduce to decoding `arg` — meaning: { decode, input: arg }.
 */
function getResilientDecoderMeaning(node, direction, path) {
  if (direction !== 'decode') return null;
  const callee = node.callee;
  if (!callee || (!t.isArrowFunctionExpression(callee) && !t.isFunctionExpression(callee))) return null;
  if (node.arguments.length !== 0) return null;

  const body = callee.body;
  if (!t.isBlockStatement(body) || body.body.length !== 1) return null;

  const tryStmt = body.body[0];
  if (!t.isTryStatement(tryStmt) || !tryStmt.block || !tryStmt.handler) return null;

  const tryBody = tryStmt.block.body;
  const handlerBody = tryStmt.handler.body ? tryStmt.handler.body.body : [];

  // Handler must return a fallback whose meaning is verified by the caller
  // (it should equal the encode-side input for the round trip to hold).
  if (handlerBody.length !== 1 || !t.isReturnStatement(handlerBody[0]) || !handlerBody[0].argument) return null;
  const fallback = handlerBody[0].argument;

  // try body: find const bin = <call>(<input>) — input may be any node
  // (identifier or literal; const-propagation often inlines it).
  let decodeArg = null;
  let binName = null;
  for (const stmt of tryBody) {
    if (t.isVariableDeclaration(stmt)) {
      for (const d of stmt.declarations) {
        if (
          d.init &&
          t.isCallExpression(d.init) &&
          d.init.arguments.length >= 1 &&
          d.init.arguments[0]
        ) {
          binName = d.id.name;
          decodeArg = d.init.arguments[0];
        }
      }
    }
  }

  if (!decodeArg || !binName) return null;

  const returns = [];
  collectReturns(tryBody, returns);
  if (returns.length === 0) return null;

  // Build the set of bin-derived names: bin itself plus any const declared
  // anywhere in the try block whose init references a bin-derived name
  // (e.g. const bytes = Uint8Array.from(bin, ...) inside the if branch).
  const allDecls = [];
  collectDeclarations(tryBody, allDecls);

  const binDerived = new Set([binName]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of allDecls) {
      if (binDerived.has(d.id.name) || !d.init) continue;
      const initSrc = safeStringify(d.init);
      for (const name of binDerived) {
        if (initSrc.includes(name)) {
          binDerived.add(d.id.name);
          grew = true;
          break;
        }
      }
    }
  }

  // Every return must reference some bin-derived name.
  for (const ret of returns) {
    if (!ret.argument) return null;
    const retSrc = safeStringify(ret.argument);
    if (![...binDerived].some((name) => retSrc.includes(name))) return null;
  }

  return { flavor: 'resilient', input: decodeArg, fallback };
}

/**
 * Collect VariableDeclarator nodes from a statement list, descending into
 * if/try/block structures.
 */
function collectDeclarations(stmts, out) {
  for (const stmt of stmts) {
    if (t.isVariableDeclaration(stmt)) {
      out.push(...stmt.declarations);
    } else if (t.isIfStatement(stmt)) {
      if (stmt.consequent) collectDeclarations(asStmtList(stmt.consequent), out);
      if (stmt.alternate) collectDeclarations(asStmtList(stmt.alternate), out);
    } else if (t.isTryStatement(stmt)) {
      if (stmt.block) collectDeclarations(stmt.block.body, out);
      if (stmt.handler && stmt.handler.body) collectDeclarations(stmt.handler.body.body, out);
    } else if (t.isBlockStatement(stmt)) {
      collectDeclarations(stmt.body, out);
    }
  }
}

/**
 * Stringify a node for containment checks; never throws.
 */
function safeStringify(node) {
  try {
    const generate = require('@babel/generator').default;
    return generate(node).code;
  } catch (e) {
    return '';
  }
}

/**
 * Collect all return statements' argument nodes within a statement list,
 * descending into if/try blocks.
 */
function collectReturns(stmts, out) {
  for (const stmt of stmts) {
    if (t.isReturnStatement(stmt)) {
      out.push(stmt);
    } else if (t.isIfStatement(stmt)) {
      if (stmt.consequent) collectReturns(asStmtList(stmt.consequent), out);
      if (stmt.alternate) collectReturns(asStmtList(stmt.alternate), out);
    } else if (t.isTryStatement(stmt)) {
      if (stmt.block) collectReturns(stmt.block.body, out);
      if (stmt.handler && stmt.handler.body) collectReturns(stmt.handler.body.body, out);
    }
  }
}

function asStmtList(nodeOrList) {
  if (t.isBlockStatement(nodeOrList)) return nodeOrList.body;
  return [nodeOrList];
}
function nodesEqualShallow(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.type !== b.type) return false;
  if (t.isIdentifier(a)) return a.name === b.name;
  if (t.isStringLiteral(a) || t.isNumericLiteral(a) || t.isBooleanLiteral(a)) return a.value === b.value;
  if (t.isMemberExpression(a)) {
    return nodesEqualShallow(a.object, b.object) && nodesEqualShallow(a.property, b.property) && a.computed === b.computed;
  }
  if (t.isCallExpression(a)) {
    return (
      nodesEqualShallow(a.callee, b.callee) &&
      a.arguments.length === b.arguments.length &&
      a.arguments.every((arg, i) => nodesEqualShallow(arg, b.arguments[i]))
    );
  }
  return false;
}

/**
 * Extract the effective body of a const-bound single-param wrapper:
 *  - expression arrow: `s => atob(s)`
 *  - return-only block: `s => { return atob(s); }`
 *  - typeof-branch block: `s => { if (typeof atob === "function") return atob(s); return Buffer...; }`
 *    -> resolves when ALL branches carry the same meaning.
 */
function getWrapperBody(node, path) {
  const binding = path.scope.getBinding(node.callee.name);
  if (!binding || !binding.path || !binding.path.isVariableDeclarator()) return null;
  if (binding.path.parentPath.node.kind !== 'const') return null;

  const init = binding.path.node.init;
  if (!init || !t.isArrowFunctionExpression(init)) return null;
  if (init.params.length !== 1 || !t.isIdentifier(init.params[0])) return null;

  const body = init.body;
  const param = init.params[0].name;

  // Expression body.
  if (!t.isBlockStatement(body)) return body;

  // Single return.
  if (body.body.length === 1 && t.isReturnStatement(body.body[0]) && body.body[0].argument) {
    return body.body[0].argument;
  }

  // typeof-branch idiom: if (...) return A; return B;
  if (body.body.length === 2) {
    const [ifStmt, retStmt] = body.body;
    if (
      t.isIfStatement(ifStmt) &&
      t.isBlockStatement(ifStmt.consequent) &&
      ifStmt.consequent.body.length === 1 &&
      t.isReturnStatement(ifStmt.consequent.body[0]) &&
      ifStmt.consequent.body[0].argument &&
      t.isReturnStatement(retStmt) &&
      retStmt.argument &&
      isTypeofTestOn(ifStmt.test)
    ) {
      // Return whichever branch uses the param — meaning is checked by caller.
      const a = ifStmt.consequent.body[0].argument;
      const b = retStmt.argument;
      if (usesIdentifier(a, param) && usesIdentifier(b, param)) {
        return { __branches: [a, b], param };
      }
    }
  }

  return null;
}

function isTypeofTestOn(test) {
  return t.isBinaryExpression(test) && t.isUnaryExpression(test.left) && test.left.operator === 'typeof';
}

function usesIdentifier(node, name) {
  let found = false;
  const { traverse } = require('../utils');
  try {
    traverse(
      { type: 'File', program: { type: 'Program', body: [t.expressionStatement(t.cloneNode(node, true))] } },
      {
        Identifier(p) {
          if (p.node.name === name) found = true;
        },
      }
    );
  } catch (e) {
    return false;
  }
  return found;
}

/**
 * The raw idiom matcher without wrapper resolution.
 */
function getDirectB64Meaning(node, direction) {
  const callee = node.callee;

  // atob(s) — decode
  if (direction === 'decode' && t.isIdentifier(callee, { name: 'atob' })) return { flavor: 'web' };
  // btoa(s) — encode
  if (direction === 'encode' && t.isIdentifier(callee, { name: 'btoa' })) return { flavor: 'web' };
  // unescape(s) — utf8 decode (percent-decode idiom)
  if (direction === 'decode' && t.isIdentifier(callee, { name: 'unescape' })) return { flavor: 'utf8', utf8: true };
  if (direction === 'encode' && t.isIdentifier(callee, { name: 'escape' })) return { flavor: 'utf8', utf8: true };
  if (direction === 'decode' && t.isIdentifier(callee, { name: 'decodeURIComponent' })) return { flavor: 'utf8', utf8: true };
  if (direction === 'encode' && t.isIdentifier(callee, { name: 'encodeURIComponent' })) return { flavor: 'utf8', utf8: true };

  // Buffer.from(s, 'base64') — decode
  if (
    direction === 'decode' &&
    t.isMemberExpression(callee) &&
    t.isIdentifier(callee.object, { name: 'Buffer' }) &&
    t.isIdentifier(callee.property, { name: 'from' }) &&
    node.arguments.length === 2
  ) {
    const enc = node.arguments[1];
    if (t.isStringLiteral(enc, { value: 'base64' })) return { flavor: 'node' };
  }

  // inner.toString('base64') — encode. Object may be any expression
  // (e.g. Buffer.from(x) — a CallExpression).
  if (
    direction === 'encode' &&
    t.isMemberExpression(callee) &&
    !callee.computed &&
    t.isIdentifier(callee.property, { name: 'toString' }) &&
    node.arguments.length === 1
  ) {
    const enc = node.arguments[0];
    if (t.isStringLiteral(enc, { value: 'base64' })) return { flavor: 'node' };
  }

  // buf.toString('utf8') / .toString('binary') — utf8/binary decode.
  if (
    direction === 'decode' &&
    t.isMemberExpression(callee) &&
    !callee.computed &&
    t.isIdentifier(callee.property, { name: 'toString' }) &&
    node.arguments.length === 1
  ) {
    const enc = node.arguments[0];
    if (t.isStringLiteral(enc, { value: 'utf8' })) return { flavor: 'utf8', utf8: true };
    if (t.isStringLiteral(enc, { value: 'binary' })) return { flavor: 'latin1' };
  }

  // Buffer.from(s, 'utf8') — utf8 encode
  if (
    direction === 'encode' &&
    t.isMemberExpression(callee) &&
    t.isIdentifier(callee.object, { name: 'Buffer' }) &&
    t.isIdentifier(callee.property, { name: 'from' }) &&
    node.arguments.length === 2
  ) {
    const enc = node.arguments[1];
    if (t.isStringLiteral(enc, { value: 'utf8' })) return { flavor: 'utf8', utf8: true };
    if (t.isStringLiteral(enc, { value: 'binary' })) return { flavor: 'latin1' };
  }

  return null;
}

/**
 * Determine the "meaning" of a call for UTF-8 encode/decode idioms
 * that round-trip exactly (the b64 wrappers in obfuscators often use
 * these between encode steps).
 */
function getUtf8Meaning(node, direction, path) {
  return getB64Meaning(node, direction, path);
}

/**
 * Shallow structural equality of two AST nodes (ignores locations).
 */
function nodesEqual(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;

  if (t.isIdentifier(a) && t.isIdentifier(b)) {
    return a.name === b.name;
  }
  if (t.isStringLiteral(a) && t.isStringLiteral(b)) {
    return a.value === b.value;
  }
  if (t.isNumericLiteral(a) && t.isNumericLiteral(b)) {
    return a.value === b.value;
  }
  if (t.isBooleanLiteral(a) && t.isBooleanLiteral(b)) {
    return a.value === b.value;
  }
  if (t.isNullLiteral(a) && t.isNullLiteral(b)) {
    return true;
  }
  return false;
}

module.exports = identityResolve;