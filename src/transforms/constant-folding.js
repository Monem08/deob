'use strict';

const t = require('@babel/types');
const { evaluate, valueToNode, withScope } = require('../evaluator');

/**
 * Pass 1: Constant folding.
 * Replaces statically-evaluable expressions with their literal value.
 */
function constantFolding(ast) {
  const { traverse } = require('../utils');

  let changed = true;
  let iterations = 0;

  while (changed && iterations < 20) {
    changed = false;
    iterations++;

    traverse(ast, {
      UnaryExpression(path) {
        const ev = withScope(path.scope, () => evaluate(path.node));
        if (ev.confident && !t.isLiteral(path.node)) {
          path.replaceWith(valueToNode(ev.value));
          changed = true;
        }
      },
      BinaryExpression(path) {
        // Structural self-cancellation first (works on non-constant operands):
        //   X ^ X -> 0, X - X -> 0, X ^ 0 -> X, X - 0 -> X, X + 0 -> X (numeric),
        //   X & 0 -> 0, X | 0 -> X, X * 1 -> X, X * 0 -> 0,
        //   X && X -> X, X || X -> X, comparisons X === X -> true, X !== X -> false
        const selfFold = trySelfCancel(path);
        if (selfFold) {
          changed = true;
          return;
        }

        // Opaque predicate next: <constant>.constructor === Array.
        const op = path.node.operator;
        if (op === '===' || op === '==' || op === '!==' || op === '!=') {
          const leftInfo = getConstructorInfo(path.node.left, path);
          const rightInfo = getConstructorInfo(path.node.right, path);
          const ctorInfo = leftInfo || rightInfo;
          const isArrayCmp =
            t.isIdentifier(path.node.left, { name: 'Array' }) ||
            t.isIdentifier(path.node.right, { name: 'Array' });
          if (ctorInfo && isArrayCmp) {
            const equal = ctorInfo.isArray;
            const positive = op === '===' || op === '==';
            path.replaceWith(t.booleanLiteral(positive ? equal : !equal));
            changed = true;
            return;
          }
        }

        // General constant folding.
        const ev = withScope(path.scope, () => evaluate(path.node));
        if (ev.confident) {
          path.replaceWith(valueToNode(ev.value));
          changed = true;
        }
      },
      LogicalExpression(path) {
        const ev = withScope(path.scope, () => evaluate(path.node));
        if (ev.confident) {
          path.replaceWith(valueToNode(ev.value));
          changed = true;
        }
      },
      ConditionalExpression(path) {
        const ev = withScope(path.scope, () => evaluate(path.node));
        if (ev.confident) {
          path.replaceWith(valueToNode(ev.value));
          changed = true;
        }
      },
      TemplateLiteral(path) {
        if (path.node.expressions.length === 0) {
          const ev = withScope(path.scope, () => evaluate(path.node));
          if (ev.confident) {
            path.replaceWith(t.stringLiteral(ev.value));
            changed = true;
          }
        }
      },
      CallExpression(path) {
        const ev = withScope(path.scope, () => evaluate(path.node));
        if (ev.confident) {
          path.replaceWith(valueToNode(ev.value));
          changed = true;
        }
      },
    });
  }

  return ast;
}

/**
 * Fold self-cancelling binary expressions where the operands are
 * structurally identical or annihilating constants. Returns true when
 * a fold happened.
 */
function trySelfCancel(path) {
  const node = path.node;
  const l = node.left;
  const r = node.right;

  const lConst = withScope(path.scope, () => evaluate(l));
  const rConst = withScope(path.scope, () => evaluate(r));

  // Both constant -> normal folding handles it.
  if (lConst.confident && rConst.confident) return false;

  const sameOperand = () => nodesEqualShallow(l, r);

  switch (node.operator) {
    case '^':
      if (sameOperand()) { path.replaceWith(t.numericLiteral(0)); return true; }
      if (rConst.confident && rConst.value === 0) { path.replaceWith(t.cloneNode(l, true)); return true; }
      if (lConst.confident && lConst.value === 0) { path.replaceWith(t.cloneNode(r, true)); return true; }
      break;
    case '-':
      if (sameOperand()) { path.replaceWith(t.numericLiteral(0)); return true; }
      if (rConst.confident && rConst.value === 0) { path.replaceWith(t.cloneNode(l, true)); return true; }
      break;
    case '+':
      if (rConst.confident && rConst.value === 0 && isNumericish(l)) { path.replaceWith(t.cloneNode(l, true)); return true; }
      if (lConst.confident && lConst.value === 0 && isNumericish(r)) { path.replaceWith(t.cloneNode(r, true)); return true; }
      break;
    case '&':
      if (rConst.confident && rConst.value === 0) { path.replaceWith(t.numericLiteral(0)); return true; }
      if (lConst.confident && lConst.value === 0) { path.replaceWith(t.numericLiteral(0)); return true; }
      break;
    case '|':
      if (rConst.confident && rConst.value === 0) { path.replaceWith(t.cloneNode(l, true)); return true; }
      if (lConst.confident && lConst.value === 0) { path.replaceWith(t.cloneNode(r, true)); return true; }
      break;
    case '*':
      if (rConst.confident && rConst.value === 1) { path.replaceWith(t.cloneNode(l, true)); return true; }
      if (lConst.confident && lConst.value === 1) { path.replaceWith(t.cloneNode(r, true)); return true; }
      if (rConst.confident && rConst.value === 0) { path.replaceWith(t.numericLiteral(0)); return true; }
      if (lConst.confident && lConst.value === 0) { path.replaceWith(t.numericLiteral(0)); return true; }
      break;
    case '===':
      if (sameOperand()) { path.replaceWith(t.booleanLiteral(true)); return true; }
      break;
    case '!==':
      if (sameOperand()) { path.replaceWith(t.booleanLiteral(false)); return true; }
      break;
  }

  // Logical: X && X -> X, X || X -> X
  if (t.isLogicalExpression(node)) {
    if ((node.operator === '&&' || node.operator === '||') && nodesEqualShallow(l, r)) {
      path.replaceWith(t.cloneNode(l, true));
      return true;
    }
  }

  return false;
}

/**
 * Heuristic: is this expression numeric-typed (so + 0 folds safely)?
 */
function isNumericish(node) {
  if (t.isNumericLiteral(node) || t.isBigIntLiteral(node)) return true;
  if (t.isUnaryExpression(node) && node.operator !== 'typeof' && node.operator !== '!') {
    return isNumericish(node.argument);
  }
  if (t.isBinaryExpression(node)) {
    return ['-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>'].includes(node.operator);
  }
  return false;
}

/**
 * Shallow structural equality: same identifier, or same literal value.
 * Deep enough for the X op X patterns obfuscators emit.
 */
function nodesEqualShallow(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.type !== b.type) return false;

  if (t.isIdentifier(a)) return a.name === b.name;
  if (t.isStringLiteral(a) || t.isNumericLiteral(a) || t.isBooleanLiteral(a)) {
    return a.value === b.value;
  }
  if (t.isUnaryExpression(a)) {
    return a.operator === b.operator && nodesEqualShallow(a.argument, b.argument);
  }
  if (t.isBinaryExpression(a) || t.isLogicalExpression(a)) {
    return a.operator === b.operator && nodesEqualShallow(a.left, b.left) && nodesEqualShallow(a.right, b.right);
  }
  if (t.isMemberExpression(a)) {
    return (
      nodesEqualShallow(a.object, b.object) &&
      nodesEqualShallow(a.property, b.property) &&
      a.computed === b.computed
    );
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
 * If the node's constructor identity is statically known, return it.
 * Only Array is relevant for the opaque-predicate pattern.
 * Identifiers are resolved through their binding's init.
 */
function getConstructorInfo(node, path) {
  if (!node || !t.isMemberExpression(node) || node.computed) return null;
  if (!t.isIdentifier(node.property, { name: 'constructor' })) return null;

  let obj = node.object;

  // Resolve identifier object through its binding's init (one level).
  if (t.isIdentifier(obj) && path) {
    const binding = path.scope.getBinding(obj.name);
    if (binding && binding.path.isVariableDeclarator() && binding.constant) {
      obj = binding.path.node.init;
    }
  }

  if (!obj) return null;
  if (t.isArrayExpression(obj)) return { isArray: true };
  if (t.isObjectExpression(obj)) return { isArray: false };
  if (t.isStringLiteral(obj) || t.isTemplateLiteral(obj)) return { isArray: false };
  if (t.isNumericLiteral(obj) || t.isBooleanLiteral(obj)) return { isArray: false };
  return null;
}

module.exports = constantFolding;
