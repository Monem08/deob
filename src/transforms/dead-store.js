'use strict';

const t = require('@babel/types');

/**
 * Pass: Dead-store elimination.
 *
 * Removes variables that are written but never read, along with the
 * statements and loops whose only observable effect is writing to them.
 * This kills the common obfuscator "red herring" junk such as:
 *
 *   let _0xdead = 0;
 *   for (let i = 0; i < _0xstate.length; i++) {
 *     _0xdead ^= _0xstate[i] << (i & 3);
 *   }
 *
 * Reference counting is done manually via fresh traversals so results
 * stay correct even after earlier passes have mutated the AST.
 */
function deadStoreElimination(ast) {
  const { traverse } = require('../utils');

  let changed = true;
  let iterations = 0;

  while (changed && iterations < 10) {
    changed = false;
    iterations++;

    const declared = collectDeclared(ast);
    if (declared.size === 0) break;

    const readCounts = countReads(ast, declared);

    const deadNames = new Set();
    for (const name of declared.keys()) {
      if ((readCounts.get(name) || 0) === 0) deadNames.add(name);
    }
    if (deadNames.size === 0) break;

    traverse(ast, {
      // Remove statements that only write to dead variables.
      ExpressionStatement(path) {
        if (isInertExpression(path.node.expression, deadNames)) {
          path.remove();
          changed = true;
        }
      },

      // Remove loops whose entire body only writes to dead / loop-local vars.
      ForStatement(path) {
        if (isRemovableForLoop(path, deadNames)) {
          path.remove();
          changed = true;
        }
      },

      WhileStatement(path) {
        const node = path.node;
        if (isReadOnly(node.test) && isInertBody(node.body, deadNames)) {
          path.remove();
          changed = true;
        }
      },

      // Remove leftover declarations of dead variables (side-effect-free init).
      VariableDeclarator(path) {
        const id = path.node.id;
        if (!t.isIdentifier(id) || !deadNames.has(id.name)) return;
        // Safety: ensure no WRITE to this name remains anywhere — earlier
        // loop/statement removals should have cleared them, but a leftover
        // write (e.g. inside a surviving loop) means removal is unsafe.
        if (hasWrites(ast, id.name)) return;
        if (!path.node.init || isSideEffectFreeInit(path.node.init)) {
          const decl = path.parentPath;
          if (t.isVariableDeclaration(decl.node) && decl.node.declarations.length === 1) {
            decl.remove();
          } else {
            path.remove();
          }
          changed = true;
        }
      },
    });
  }

  return ast;
}

/**
 * Collect all declared variable names (function-scoped and block-scoped).
 */
function collectDeclared(ast) {
  const { traverse } = require('../utils');
  const declared = new Map(); // name -> true

  traverse(ast, {
    VariableDeclarator(path) {
      if (t.isIdentifier(path.node.id)) declared.set(path.node.id.name, true);
    },
    FunctionDeclaration(path) {
      if (path.node.id) declared.set(path.node.id.name, true);
    },
  });

  return declared;
}

/**
 * Count how many times each declared name is READ (not written).
 * A read is any identifier reference that is not an assignment target,
 * an update argument, or a declaration id.
 */
function countReads(ast, declared) {
  const { traverse } = require('../utils');
  const reads = new Map();

  const addRead = (name) => {
    if (!declared.has(name)) return;
    reads.set(name, (reads.get(name) || 0) + 1);
  };

  traverse(ast, {
    Identifier(path) {
      const name = path.node.name;
      if (!declared.has(name)) return;

      const parent = path.parent;

      // Declaration id — not a read.
      if (t.isVariableDeclarator(parent) && parent.id === path.node) return;
      if (t.isFunctionDeclaration(parent) && parent.id === path.node) return;

      // Assignment target — a write, not a read.
      if (t.isAssignmentExpression(parent) && parent.left === path.node) return;
      if (t.isUpdateExpression(parent) && parent.argument === path.node) return;

      // LHS of for-of / for-in — not a read.
      if ((t.isForOfStatement(parent) || t.isForInStatement(parent)) && parent.left === path.node) {
        return;
      }

      // Object property shorthand key — not a read.
      if (t.isObjectProperty(parent) && parent.key === path.node && !parent.computed) return;

      // Member expression non-computed property — not a read of the name.
      if (t.isMemberExpression(parent) && parent.property === path.node && !parent.computed) return;

      addRead(name);
    },
  });

  return reads;
}

/**
 * Count writes (assignment targets / update arguments) to a name.
 */
function hasWrites(ast, name) {
  const { traverse } = require('../utils');
  let found = false;
  traverse(ast, {
    AssignmentExpression(path) {
      if (t.isIdentifier(path.node.left, { name })) found = true;
    },
    UpdateExpression(path) {
      if (t.isIdentifier(path.node.argument, { name })) found = true;
    },
  });
  return found;
}

/**
 * A for loop is removable when every name it declares in its init is
 * referenced only from inside the loop, and all of its statements only
 * write to dead or loop-local variables.
 */
function isRemovableForLoop(path, deadNames) {
  const node = path.node;
  const targets = new Set(deadNames);

  if (node.init) {
    if (t.isVariableDeclaration(node.init)) {
      for (const d of node.init.declarations) {
        if (!t.isIdentifier(d.id)) return false;
        // The init-declared name must not be referenced outside this loop.
        const binding = path.scope.getBinding(d.id.name);
        const contained =
          !binding || binding.referencePaths.every((r) => r.find((p) => p === path) != null);
        if (!contained) return false;
        targets.add(d.id.name);
        if (d.init && !isReadOnly(d.init)) return false;
      }
    } else if (!isInertExpression(node.init, targets)) {
      return false;
    }
  }

  if (node.test && !isReadOnly(node.test)) return false;
  if (node.update && !isInertExpression(node.update, targets)) return false;
  return isInertBody(node.body, targets);
}

/**
 * An expression is inert when its only effect is writing to a dead variable.
 */
function isInertExpression(node, targets) {
  if (!node) return false;
  if (t.isAssignmentExpression(node)) {
    const lhs = node.left;
    return t.isIdentifier(lhs) && targets.has(lhs.name) && isReadOnly(node.right);
  }
  if (t.isUpdateExpression(node)) {
    return t.isIdentifier(node.argument) && targets.has(node.argument.name);
  }
  if (t.isSequenceExpression(node)) {
    return node.expressions.every((e) => isInertExpression(e, targets));
  }
  return false;
}

function isInertBody(body, targets) {
  if (t.isBlockStatement(body)) {
    return body.body.every((s) => isInertStatement(s, targets));
  }
  return isInertExpression(body, targets);
}

function isInertStatement(stmt, targets) {
  if (t.isEmptyStatement(stmt)) return true;
  if (t.isExpressionStatement(stmt)) return isInertExpression(stmt.expression, targets);
  if (t.isVariableDeclaration(stmt)) {
    if (stmt.kind === 'var') {
      // var hoists to function scope — only removable when the name is dead.
      return stmt.declarations.every(
        (d) => t.isIdentifier(d.id) && targets.has(d.id.name) && (!d.init || isReadOnly(d.init))
      );
    }
    // let/const are block-scoped — removing the loop kills them safely.
    return stmt.declarations.every(
      (d) => t.isIdentifier(d.id) && (!d.init || isReadOnly(d.init))
    );
  }
  return false;
}

/**
 * True when the expression only reads (no calls, writes, deletes, awaits).
 */
function isReadOnly(node) {
  if (!node) return true;
  switch (node.type) {
    case 'Identifier':
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'RegExpLiteral':
    case 'BigIntLiteral':
    case 'ThisExpression':
    case 'Super':
      return true;
    case 'MemberExpression':
      return isReadOnly(node.object) && (!node.computed || isReadOnly(node.property));
    case 'BinaryExpression':
      return isReadOnly(node.left) && isReadOnly(node.right);
    case 'LogicalExpression':
      return isReadOnly(node.left) && isReadOnly(node.right);
    case 'UnaryExpression':
      return node.operator !== 'delete' && isReadOnly(node.argument);
    case 'SequenceExpression':
      return node.expressions.every(isReadOnly);
    case 'ConditionalExpression':
      return isReadOnly(node.test) && isReadOnly(node.consequent) && isReadOnly(node.alternate);
    case 'TemplateLiteral':
      return node.expressions.every(isReadOnly);
    case 'ArrayExpression':
      return node.elements.every((e) => e === null || isReadOnly(e));
    case 'CallExpression':
    {
      // Pure Math functions are safe to read.
      const c = node.callee;
      if (
        t.isMemberExpression(c) &&
        !c.computed &&
        t.isIdentifier(c.object, { name: 'Math' }) &&
        t.isIdentifier(c.property)
      ) {
        return typeof Math[c.property.name] === 'function' && node.arguments.every(isReadOnly);
      }
      // String.fromCharCode / fromCodePoint are pure.
      if (
        t.isMemberExpression(c) &&
        t.isIdentifier(c.object, { name: 'String' }) &&
        (t.isIdentifier(c.property, { name: 'fromCharCode' }) ||
          t.isIdentifier(c.property, { name: 'fromCodePoint' }))
      ) {
        return node.arguments.every(isReadOnly);
      }
      return false;
    }
    default:
      return false;
  }
}

function isSideEffectFreeInit(node) {
  if (!node) return true;
  if (isReadOnly(node)) return true;
  if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) return true;
  if (t.isObjectExpression(node)) {
    return node.properties.every(
      (p) => t.isObjectProperty(p) && (!p.computed || isReadOnly(p.key)) && isSideEffectFreeInit(p.value)
    );
  }
  if (t.isArrayExpression(node)) {
    return node.elements.every((e) => e === null || isSideEffectFreeInit(e));
  }
  return false;
}

module.exports = deadStoreElimination;
module.exports.isReadOnly = isReadOnly;