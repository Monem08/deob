'use strict';

const t = require('@babel/types');
const { evaluate, valueToNode } = require('../evaluator');

/**
 * Pass 5: Control flow unflattening.
 *
 * Handles the common "switch dispatcher" obfuscation:
 *
 *   var _0x = '1|0|2'.split('|');
 *   var _i = 0;
 *   while (true) {
 *     switch (_0x[_i++]) {
 *       case '0': ...; continue;
 *       case '1': ...; continue;
 *       case '2': ...; break;
 *     }
 *     break;
 *   }
 *
 * Reconstructs the original sequential flow by evaluating the dispatcher
 * array and stitching case bodies together in order.
 */
function unflattenControlFlow(ast) {
  const { traverse } = require('../utils');

  // Find dispatcher arrays: `var x = 'a|b|c'.split('|')`.
  const dispatchers = new Map(); // name -> ordered case keys

  traverse(ast, {
    VariableDeclarator(path) {
      const id = path.node.id;
      const init = path.node.init;
      if (!t.isIdentifier(id)) return;

      // Form A: var x = 'a|b|c'.split('|')  (dot or ['split'] computed)
      let parts = null;
      if (t.isCallExpression(init) && t.isMemberExpression(init.callee)) {
        const prop = init.callee.computed
          ? t.isStringLiteral(init.callee.property) ? init.callee.property.value : null
          : t.isIdentifier(init.callee.property) ? init.callee.property.name : null;
        const obj = init.callee.object;
        const sep = init.arguments[0];
        if (prop === 'split' && t.isStringLiteral(obj) && t.isStringLiteral(sep)) {
          const split = obj.value.split(sep.value);
          if (split.length >= 2) parts = split;
        }
      }
      // Form B: var x = ['a', 'b', 'c']  (constant-folding's product)
      else if (t.isArrayExpression(init) && init.elements.length >= 2) {
        const arr = [];
        let ok = true;
        for (const el of init.elements) {
          if (el && t.isStringLiteral(el)) arr.push(el.value);
          else { ok = false; break; }
        }
        if (ok) parts = arr;
      }

      if (!parts) return;
      dispatchers.set(id.name, parts);
    },
  });

  if (dispatchers.size === 0) return ast;

  let unflattened = 0;

  traverse(ast, {
    WhileStatement(path) {
      const test = path.node.test;
      if (!t.isBooleanLiteral(test, { value: true })) return;

      const body = path.node.body;
      if (!t.isBlockStatement(body)) return;

      // Find the switch statement inside.
      const switchStmt = body.body.find((s) => t.isSwitchStatement(s));
      if (!switchStmt) return;

      // Find the dispatcher array reference in the switch discriminant.
      const disc = switchStmt.discriminant;
      let dispatcherName = null;
      if (t.isMemberExpression(disc) && t.isIdentifier(disc.object)) {
        dispatcherName = disc.object.name;
      }
      if (!dispatcherName || !dispatchers.has(dispatcherName)) return;

      const order = dispatchers.get(dispatcherName);

      // Map case test values -> consequent statements.
      const cases = new Map();
      for (const c of switchStmt.cases) {
        if (!c.test) continue;
        const ev = evaluate(c.test);
        if (!ev.confident) return;
        cases.set(String(ev.value), c.consequent);
      }

      // Build the reconstructed sequence.
      const reconstructed = [];
      for (const key of order) {
        const consequent = cases.get(key);
        if (!consequent) return;
        for (const stmt of consequent) {
          // Drop `continue;` statements (they just loop the dispatcher).
          if (t.isContinueStatement(stmt)) continue;
          // Drop `break;` statements that exit the switch.
          if (t.isBreakStatement(stmt)) continue;
          reconstructed.push(t.cloneNode(stmt, true));
        }
      }

      if (reconstructed.length === 0) return;

      path.replaceWithMultiple(reconstructed);
      unflattened++;

      // Remove the dispatcher array and index variable declarations if now unused.
      removeUnusedBinding(ast, dispatcherName);
      if (t.isIdentifier(disc.object)) {
        // The index variable is typically incremented in the discriminant.
        // Find `var _0xi = 0` style declarations that are now unused.
        removeUnusedIndexDeclarations(ast);
      }
    },
  });

  return ast;
}

/**
 * Remove a variable declaration whose binding is no longer referenced.
 */
function removeUnusedBinding(ast, name) {
  const { traverse } = require('../utils');
  traverse(ast, {
    VariableDeclarator(path) {
      if (t.isIdentifier(path.node.id, { name })) {
        if (countReferences(ast, name) === 0) {
          const decl = path.parentPath;
          if (t.isVariableDeclaration(decl.node) && decl.node.declarations.length === 1) {
            decl.remove();
          } else {
            path.remove();
          }
        }
      }
    },
  });
}

/**
 * Remove index variable declarations (e.g. `var _0xi = 0`) that are unused.
 */
function removeUnusedIndexDeclarations(ast) {
  const { traverse } = require('../utils');
  traverse(ast, {
    VariableDeclarator(path) {
      const id = path.node.id;
      if (!t.isIdentifier(id)) return;
      if (countReferences(ast, id.name) === 0) {
        const decl = path.parentPath;
        if (t.isVariableDeclaration(decl.node) && decl.node.declarations.length === 1) {
          decl.remove();
        } else {
          path.remove();
        }
      }
    },
  });
}

/**
 * Count how many times an identifier name is referenced in the AST,
 * excluding its own declaration site.
 */
function countReferences(ast, name) {
  const { traverse } = require('../utils');
  let count = 0;
  traverse(ast, {
    Identifier(path) {
      if (path.node.name === name && path.isReferencedIdentifier()) {
        count++;
      }
    },
  });
  return count;
}

module.exports = unflattenControlFlow;
