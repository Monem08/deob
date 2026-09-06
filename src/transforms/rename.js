'use strict';

const t = require('@babel/types');

/**
 * Pass: Identifier renaming for readability.
 *
 * Renames obfuscated identifiers (`_0xdeadbeef` style) to short, semantic
 * names inferred from how each binding is used:
 *
 *   - called            -> fn0, fn1, ...
 *   - holds array       -> arr0, arr1, ...
 *   - holds function    -> fn0, fn1, ...
 *   - holds string      -> str0, str1, ...
 *   - holds number      -> num0, num1, ...
 *   - loop counter      -> i, j, k, ...
 *   - anything else     -> v0, v1, ...
 *
 * Scope-safe: uses Babel's binding rename so shadowing is respected.
 */
function renameIdentifiers(ast) {
  const { traverse } = require('../utils');

  const counters = {
    fn: 0, arr: 0, str: 0, num: 0, v: 0,
  };
  const loopNames = ['i', 'j', 'k', 'm', 'n', 'p', 'q'];

  // First pass: detect loop counters by looking at for/for-of/while inits.
  const loopCounterNames = new Set();
  traverse(ast, {
    ForStatement(path) {
      const init = path.node.init;
      if (init && t.isVariableDeclaration(init)) {
        for (const d of init.declarations) {
          if (t.isIdentifier(d.id)) loopCounterNames.add(d.id.name);
        }
      }
    },
    ForOfStatement(path) {
      if (t.isIdentifier(path.node.left)) loopCounterNames.add(path.node.left.name);
      if (t.isVariableDeclaration(path.node.left)) {
        for (const d of path.node.left.declarations) {
          if (t.isIdentifier(d.id)) loopCounterNames.add(d.id.name);
        }
      }
    },
  });

  const assignedLoopIdx = new Map(); // original name -> loop letter

  traverse(ast, {
    Scope(scopePath) {
      for (const [name, binding] of Object.entries(scopePath.scope.bindings)) {
        if (!isObfuscatedName(name)) continue;
        if (!binding.path) continue;

        let newName = null;

        // Loop counter?
        if (loopCounterNames.has(name)) {
          const letter = loopNames[Math.min(assignedLoopIdx.size, loopNames.length - 1)];
          let idx = assignedLoopIdx.get(name);
          if (idx === undefined) {
            idx = counters.v; // reuse counter space for uniqueness
            assignedLoopIdx.set(name, idx);
          }
          newName = letter + (idx > 0 ? String(idx) : '');
          counters.v++;
        } else if (inferKind(binding) === 'function') {
          newName = 'fn' + counters.fn++;
        } else if (inferKind(binding) === 'array') {
          newName = 'arr' + counters.arr++;
        } else if (inferKind(binding) === 'string') {
          newName = 'str' + counters.str++;
        } else if (inferKind(binding) === 'number') {
          newName = 'num' + counters.num++;
        } else {
          newName = 'v' + counters.v++;
        }

        // Ensure the new name doesn't collide with an existing binding.
        newName = uniquify(newName, scopePath.scope);

        try {
          binding.path.scope.rename(name, newName);
        } catch (e) {
          // rename can fail on pathological scoping; skip those.
        }
      }
    },
  });

  return ast;
}

function inferKind(binding) {
  const p = binding.path;

  if (p.isVariableDeclarator() && p.node.init) {
    const init = p.node.init;
    if (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) return 'function';
    if (t.isArrayExpression(init)) return 'array';
    if (t.isStringLiteral(init) || t.isTemplateLiteral(init)) return 'string';
    if (t.isNumericLiteral(init)) return 'number';
  }
  if (p.isFunctionDeclaration()) return 'function';

  // Called somewhere?
  for (const ref of binding.referencePaths) {
    if (ref.isCallExpression() && ref.node.callee === ref.node) return 'function';
  }

  return 'other';
}

function uniquify(name, scope) {
  if (!scope.hasBinding(name)) return name;
  let i = 2;
  while (scope.hasBinding(name + i)) i++;
  return name + i;
}

/**
 * Matches obfuscator-style names: _0x4f91, hex junk, or exotic unicode
 * identifiers (𐐀, ᛉ, 𝒪) that humans never type.
 */
function isObfuscatedName(name) {
  if (name.length > 24) return true;
  if (/^_0x[0-9a-fA-F]+$/.test(name)) return true;
  if (/^_[0-9a-zA-Z]{1,6}$/.test(name)) return true;
  if (/^[0-9a-f]{6,}$/.test(name)) return true;
  // Any identifier containing chars outside [A-Za-z0-9_$] is obfuscation.
  if (!/^[A-Za-z0-9_$]+$/.test(name)) return true;
  return false;
}

module.exports = renameIdentifiers;