'use strict';

const t = require('@babel/types');

/**
 * Pass 6: Cleanup.
 *
 * - Removes redundant `!!` and `void 0`.
 * - Converts `undefined` identifiers to `void 0` (or leaves them).
 * - Removes unnecessary sequence expressions.
 * - Flattens nested block statements.
 * - Removes redundant parentheses (handled by generator).
 */
function cleanup(ast) {
  const { traverse } = require('../utils');

  let changed = true;
  let iterations = 0;

  while (changed && iterations < 20) {
    changed = false;
    iterations++;

    // Flatten nested blocks.
    traverse(ast, {
      BlockStatement(path) {
        if (path.parentPath && t.isBlockStatement(path.parentPath.node)) {
          path.replaceWithMultiple(path.node.body);
          changed = true;
        }
      },
    });

    // Collapse boolean double negation — ONLY when the inner operand is
    // statically known to be boolean. `!!x` is a type coercion, not an
    // algebraic double negative: `return !!i` where i=1 yields `true`,
    // while `return i` yields `1`. Truthy-equal but STRICT-UNEQUAL — and
    // APIs like Chrome's runtime.onMessage require a literal boolean to
    // keep the sendResponse channel open. So `!!x` only folds to `x`
    // when x's type is provably boolean.
    traverse(ast, {
      UnaryExpression(path) {
        if (path.node.operator === '!' && t.isUnaryExpression(path.node.argument, { operator: '!' })) {
          const inner = path.node.argument.argument;
          if (isStaticallyBoolean(inner)) {
            path.replaceWith(inner);
            changed = true;
          }
        }
      },
    });

    // Collapse sequence expressions with a single element.
    traverse(ast, {
      SequenceExpression(path) {
        if (path.node.expressions.length === 1) {
          path.replaceWith(path.node.expressions[0]);
          changed = true;
        }
      },
    });

    // Remove empty variable declarations.
    traverse(ast, {
      VariableDeclaration(path) {
        if (path.node.declarations.length === 0) {
          path.remove();
          changed = true;
        }
      },
    });

    // Convert computed object keys with string literals to identifier keys.
    traverse(ast, {
      ObjectProperty(path) {
        if (
          path.node.computed &&
          t.isStringLiteral(path.node.key) &&
          isValidIdentifier(path.node.key.value)
        ) {
          path.node.computed = false;
          path.node.key = t.identifier(path.node.key.value);
          changed = true;
        }
      },
    });

    // Convert computed member expressions with string literal to dot
    // notation — including optional-chained members.
    traverse(ast, {
      'MemberExpression|OptionalMemberExpression'(path) {
        if (
          path.node.computed &&
          t.isStringLiteral(path.node.property) &&
          isValidIdentifier(path.node.property.value)
        ) {
          path.node.computed = false;
          path.node.property = t.identifier(path.node.property.value);
          changed = true;
        }

        // globalThis.console.log(...) -> console.log(...)
        if (
          !path.node.computed &&
          t.isIdentifier(path.node.object, { name: 'globalThis' }) &&
          t.isIdentifier(path.node.property) &&
          path.node.property.name !== 'undefined'
        ) {
          path.replaceWith(t.identifier(path.node.property.name));
          changed = true;
        }
      },
    });

    // Split sequence expressions in statement position into separate statements.
    traverse(ast, {
      ExpressionStatement(path) {
        const expr = path.node.expression;
        if (!t.isSequenceExpression(expr) || expr.expressions.length < 2) return;

        const stmts = expr.expressions.map((e) => t.expressionStatement(e));
        path.replaceWithMultiple(stmts);
        changed = true;
      },
    });

    // Normalize number literals: strip meaningless raw forms like 0x2a when
    // the decimal value is small and clearer.
    traverse(ast, {
      NumericLiteral(path) {
        const v = path.node.value;
        if (path.node.extra && typeof path.node.extra.raw === 'string') {
          const raw = path.node.extra.raw;
          if (raw.startsWith('0x') || raw.startsWith('0X')) {
            // Only rewrite hex when it doesn't aid clarity (small values).
            if (v >= 0 && v <= 255 && !/[a-fA-F]/.test(raw.slice(2))) {
              path.node.extra.raw = String(v);
            } else {
              delete path.node.extra;
            }
          } else {
            delete path.node.extra;
          }
        }
      },
    });
  }

  return ast;
}

function isValidIdentifier(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

/**
 * Structural inference: is this expression provably boolean-typed?
 * Deliberately conservative — anything unknown returns false, which
 * preserves the `!!` coercion (the safe side).
 */
function isStaticallyBoolean(node) {
  if (!node) return false;
  switch (node.type) {
    case 'BooleanLiteral':
      return true;
    case 'BinaryExpression':
      // All comparison operators yield booleans.
      return ['==', '!=', '===', '!==', '<', '<=', '>', '>=', 'in', 'instanceof'].includes(node.operator);
    case 'LogicalExpression':
      // && / || yield the type of their operands — only boolean if both
      // sides are. `a && b` where b is boolean still yields falsy-a
      // (e.g. undefined) when a is falsy. Conservative: require both.
      return isStaticallyBoolean(node.left) && isStaticallyBoolean(node.right);
    case 'UnaryExpression':
      if (node.operator === '!') return true; // !x is always boolean
      if (node.operator === 'delete') return true;
      if (node.operator === 'void') return false; // void x is undefined
      return false; // -x, +x, ~x, typeof x are not boolean
    case 'CallExpression':
      return false; // unknown function return type
    case 'Identifier':
      return false; // unknown runtime type
    default:
      return false;
  }
}

module.exports = cleanup;
