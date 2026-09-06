'use strict';

const t = require('@babel/types');
const { evaluate } = require('../evaluator');

/**
 * Pass 3: Dead code elimination.
 *
 * Removes:
 *  - Unreachable branches of if/conditional statements whose test is constant.
 *  - Empty statements.
 *  - Unused variable declarations (best-effort).
 *  - Redundant logical expressions (e.g. `true && x` -> `x`).
 */
function deadCodeElimination(ast) {
  const { traverse } = require('../utils');

  let changed = true;
  let iterations = 0;

  while (changed && iterations < 20) {
    changed = false;
    iterations++;

    // Simplify logical expressions with constant operands.
    traverse(ast, {
      LogicalExpression(path) {
        const left = evaluate(path.node.left);
        if (!left.confident) return;

        if (path.node.operator === '&&') {
          if (left.value) {
            path.replaceWith(path.node.right);
            changed = true;
          } else {
            path.replaceWith(path.node.left);
            changed = true;
          }
        } else if (path.node.operator === '||') {
          if (left.value) {
            path.replaceWith(path.node.left);
            changed = true;
          } else {
            path.replaceWith(path.node.right);
            changed = true;
          }
        }
      },
      // Constant ternary: true ? A : B -> A   (branches need not be evaluable)
      ConditionalExpression(path) {
        const test = evaluate(path.node.test);
        if (!test.confident) return;
        path.replaceWith(test.value ? path.node.consequent : path.node.alternate);
        changed = true;
      },
    });

    // Resolve constant if statements.
    traverse(ast, {
      IfStatement(path) {
        const test = evaluate(path.node.test);
        if (!test.confident) return;

        if (test.value) {
          if (path.node.consequent) {
            path.replaceWithMultiple(
              t.isBlockStatement(path.node.consequent)
                ? path.node.consequent.body
                : [path.node.consequent]
            );
          } else {
            path.remove();
          }
        } else {
          if (path.node.alternate) {
            path.replaceWithMultiple(
              t.isBlockStatement(path.node.alternate)
                ? path.node.alternate.body
                : [path.node.alternate]
            );
          } else {
            path.remove();
          }
        }
        changed = true;
      },
    });

    // Remove empty statements.
    traverse(ast, {
      EmptyStatement(path) {
        path.remove();
        changed = true;
      },
    });

    // Remove unreachable code after return/throw/break/continue in a block.
    traverse(ast, {
      BlockStatement(path) {
        const body = path.node.body;
        for (let i = 0; i < body.length - 1; i++) {
          if (
            t.isReturnStatement(body[i]) ||
            t.isThrowStatement(body[i]) ||
            t.isBreakStatement(body[i]) ||
            t.isContinueStatement(body[i])
          ) {
            const removed = body.splice(i + 1);
            if (removed.length > 0) changed = true;
            break;
          }
        }
      },
    });
  }

  // Remove unused variables (best-effort, only top-level and function-scoped).
  traverse(ast, {
    VariableDeclarator(path) {
      const id = path.node.id;
      if (!t.isIdentifier(id)) return;
      const binding = path.scope.getBinding(id.name);
      if (!binding) return;
      if (binding.referenced === false && binding.constant) {
        // Only remove if the init has no side effects.
        if (!path.node.init || isSideEffectFree(path.node.init)) {
          const decl = path.parentPath;
          if (t.isVariableDeclaration(decl.node) && decl.node.declarations.length === 1) {
            decl.remove();
          } else {
            path.remove();
          }
          changed = true;
        }
      }
    },
  });

  // Remove unused function declarations (best-effort).
  traverse(ast, {
    FunctionDeclaration(path) {
      const name = path.node.id && path.node.id.name;
      if (!name) return;
      const binding = path.scope.getBinding(name);
      if (!binding) return;
      if (binding.referenced === false) {
        path.remove();
        changed = true;
      }
    },
  });

  return ast;
}

function isSideEffectFree(node) {
  if (!node) return true;
  if (t.isLiteral(node) || t.isIdentifier(node)) return true;
  if (t.isUnaryExpression(node)) return isSideEffectFree(node.argument);
  if (t.isBinaryExpression(node) || t.isLogicalExpression(node)) {
    return isSideEffectFree(node.left) && isSideEffectFree(node.right);
  }
  if (t.isArrayExpression(node)) return node.elements.every((e) => e === null || isSideEffectFree(e));
  if (t.isObjectExpression(node)) {
    return node.properties.every((p) => !t.isSpreadElement(p) && isSideEffectFree(p.value));
  }
  if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) return true;
  return false;
}

module.exports = deadCodeElimination;
