'use strict';

const t = require('@babel/types');
const { evaluate } = require('../evaluator');

/**
 * Pass: Single-use literal inlining.
 *
 *   const a = "log";
 *   const b = 3;
 *   console[a](b);
 *
 * becomes
 *
 *   console.log(3);
 *
 * Only inlines const bindings referenced exactly once, whose init is a
 * statically evaluable literal. Also drops single-use wrapper function
 * declarations whose body is a single return of a read-only expression,
 * inlining them at their one call site.
 */
function inlineLiterals(ast) {
  const { traverse } = require('../utils');

  let changed = true;
  let iterations = 0;

  while (changed && iterations < 10) {
    changed = false;
    iterations++;

    traverse(ast, {
      Scope(scopePath) {
        for (const [name, binding] of Object.entries(scopePath.scope.bindings)) {
          if (!binding.kind || binding.kind === 'hoisted' || binding.kind === 'param' || binding.kind === 'module') continue;
          if (binding.constantViolations.length > 0) continue;
          if (binding.referencePaths.length !== 1) continue;

          const ref = binding.referencePaths[0];
          const declPath = binding.path;

          // Case 1: const holding a literal, used exactly once -> inline.
          if (declPath.isVariableDeclarator()) {
            const init = declPath.node.init;
            if (!init) continue;
            const ev = evaluate(init);
            if (!ev.confident) continue;
            if (typeof ev.value === 'object' && ev.value !== null) continue;

            const canInline =
              t.isStringLiteral(init) ||
              t.isNumericLiteral(init) ||
              t.isBooleanLiteral(init) ||
              t.isNullLiteral(init) ||
              t.isTemplateLiteral(init);

            if (!canInline) continue;

            // Don't inline into a for-init position; replacement there is messy.
            if (ref.parent && t.isForStatement(ref.parent)) continue;

            ref.replaceWith(t.cloneNode(init, true));
            const decl = declPath.parentPath;
            if (t.isVariableDeclaration(decl.node) && decl.node.declarations.length === 1) {
              decl.remove();
            } else {
              declPath.remove();
            }
            changed = true;
          }

          // Case 2: single-use wrapper function, called exactly once.
          else if (declPath.isFunctionDeclaration() && ref.isCallExpression()) {
            const fn = declPath.node;
            const body = fn.body;
            if (!body || !t.isBlockStatement(body)) continue;
            if (body.body.length !== 1) continue;
            const ret = body.body[0];
            if (!t.isReturnStatement(ret) || !ret.argument) continue;
            if (!isReadOnlyExpr(ret.argument)) continue;

            const callPath = ref.find((p) => p.isCallExpression());
            if (!callPath || callPath.node.arguments.length !== fn.params.length) continue;

            const params = fn.params;
            if (!params.every((p) => t.isIdentifier(p))) continue;

            const subst = new Map();
            params.forEach((p, i) => subst.set(p.name, callPath.node.arguments[i]));

            const cloned = substitute(t.cloneNode(ret.argument, true), subst);
            callPath.replaceWith(cloned);

            const name = fn.id.name;
            declPath.remove();
            changed = true;

            void name;
          }
        }
      },
    });
  }

  return ast;
}

function isReadOnlyExpr(node) {
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
      return true;
    case 'MemberExpression':
    {
      const a = isReadOnlyExpr(node.object);
      const b = !node.computed || isReadOnlyExpr(node.property);
      return a && b;
    }
    case 'BinaryExpression':
    case 'LogicalExpression':
      return isReadOnlyExpr(node.left) && isReadOnlyExpr(node.right);
    case 'UnaryExpression':
      return node.operator !== 'delete' && isReadOnlyExpr(node.argument);
    case 'ConditionalExpression':
      return isReadOnlyExpr(node.test) && isReadOnlyExpr(node.consequent) && isReadOnlyExpr(node.alternate);
    case 'CallExpression':
    {
      const c = node.callee;
      if (
        t.isMemberExpression(c) &&
        t.isIdentifier(c.object, { name: 'String' }) &&
        ((t.isIdentifier(c.property, { name: 'fromCharCode' }) && !c.computed) ||
         (t.isStringLiteral(c.property, { value: 'fromCharCode' })))
      ) {
        return node.arguments.every(isReadOnlyExpr);
      }
      return false;
    }
    default:
      return false;
  }
}

function substitute(node, subst) {
  if (!node || subst.size === 0) return node;
  if (t.isIdentifier(node) && subst.has(node.name)) {
    return t.cloneNode(subst.get(node.name), true);
  }
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (value[i] && typeof value[i] === 'object' && value[i].type) {
          value[i] = substitute(value[i], subst);
        }
      }
    } else if (value && typeof value === 'object' && value.type) {
      node[key] = substitute(value, subst);
    }
  }
  return node;
}

module.exports = inlineLiterals;