'use strict';

const t = require('@babel/types');
const { isReadOnly } = require('./dead-store');

/**
 * Pass: Safe IIFE inlining.
 *
 * Unwraps the factory pattern when the function body is a chain of pure
 * statement declarations/assignments followed by a single return:
 *
 *   const run = (() => {
 *     const state = [1, 2, 3];
 *     return function () { ... };
 *   })();
 *
 * becomes
 *
 *   const state = [1, 2, 3];
 *   const run = function () { ... };
 *
 * Only applies when the replacement target is a declarator init or an
 * expression statement, so the result is always syntactically valid.
 */
function inlineIIFE(ast) {
  const { traverse } = require('../utils');

  let changed = true;
  let iterations = 0;

  while (changed && iterations < 10) {
    changed = false;
    iterations++;

    traverse(ast, {
      VariableDeclarator(path) {
        const init = path.node.init;
        if (!init || !isSimpleFactoryCall(init)) return;

        const parsed = parseFactory(init);
        if (!parsed) return;

        // The prelude must be side-effect-free.
        for (const stmt of parsed.prelude) {
          if (!isHoistableStatement(stmt)) return;
        }

        // Hoist prelude before the declaration, keep the returned value as init.
        const decl = path.parentPath;
        if (!t.isVariableDeclaration(decl.node) || decl.node.declarations.length !== 1) return;

        const hoisted = parsed.prelude.map((s) => t.cloneNode(s, true));
        const newInit = t.cloneNode(parsed.returnValue, true);

        decl.insertBefore(hoisted);
        path.get('init').replaceWith(newInit);
        changed = true;
      },

      ExpressionStatement(path) {
        const expr = path.node.expression;
        if (!isSimpleFactoryCall(expr)) return;

        const parsed = parseFactory(expr);
        if (!parsed) return;

        for (const stmt of parsed.prelude) {
          if (!isHoistableStatement(stmt)) return;
        }

        const replacement = parsed.prelude.map((s) => t.cloneNode(s, true));
        replacement.push(t.cloneNode(parsed.returnValue, true));
        path.replaceWithMultiple(replacement);
        changed = true;
      },
    });
  }

  return ast;
}

function isSimpleFactoryCall(node) {
  return (
    t.isCallExpression(node) &&
    node.arguments.length === 0 &&
    (t.isFunctionExpression(node.callee) || t.isArrowFunctionExpression(node.callee))
  );
}

/**
 * Matches a function body of the shape:
 *   stmt*; return <expr>;
 * with no return argument missing and nothing after the return.
 */
function parseFactory(call) {
  const fn = call.callee;
  const body = fn.body;
  if (!t.isBlockStatement(body)) return null;

  const last = body.body[body.body.length - 1];
  if (!last || !t.isReturnStatement(last) || !last.argument) return null;

  const prelude = body.body.slice(0, -1);
  for (const stmt of prelude) {
    if (!isHoistableStatement(stmt)) return null;
  }

  return { prelude, returnValue: last.argument };
}

/**
 * Statements we are willing to hoist out of the IIFE:
 * variable declarations with read-only inits and read-only expression
 * statements. Everything else bails out.
 */
function isHoistableStatement(stmt) {
  if (t.isVariableDeclaration(stmt)) {
    if (stmt.kind === 'var') return false; // hoisting var out of block changes semantics
    return stmt.declarations.every(
      (d) => t.isIdentifier(d.id) && (!d.init || isReadOnly(d.init))
    );
  }
  if (t.isExpressionStatement(stmt)) return isReadOnly(stmt.expression);
  return false;
}

module.exports = inlineIIFE;