'use strict';

const t = require('@babel/types');
const { evaluate, valueToNode, withScope } = require('../evaluator');

/**
 * Pass: Alias folding.
 *
 * Resolves calls to const-bound single-expression arrow functions
 * (a very common obfuscation idiom):
 *
 *   const _str = arr => String.fromCharCode(...arr);
 *   _str([99, 111])            ->  "co"
 *
 *   const _xor = (arr, key) => arr.map((x, i) => x ^ (key + i * 31) & 255);
 *   _xor([1, 2, 3], 73)         ->  [114, 115, 116...]
 *
 * Only fires when all arguments are statically evaluable and the
 * lambda body (after parameter substitution) also evaluates.
 * Falls back to leaving the call untouched when anything is unknown.
 */
function aliasFold(ast) {
  const { traverse } = require('../utils');

  let changed = true;
  let iterations = 0;

  while (changed && iterations < 10) {
    changed = false;
    iterations++;

    traverse(ast, {
      CallExpression(path) {
        if (tryFoldCall(path)) {
          changed = true;
        }
      },
    });
  }

  return ast;
}

function tryFoldCall(path) {
  const node = path.node;
  const callee = node.callee;
  if (!t.isIdentifier(callee)) return false;

  const binding = path.scope.getBinding(callee.name);
  if (!binding || !binding.path || !binding.path.isVariableDeclarator()) return false;

  const decl = binding.path;
  const init = decl.node.init;

  // Only const-bound arrow functions with expression bodies or
  // const-decls + single-return block bodies.
  if (!init || !t.isArrowFunctionExpression(init)) return false;
  if (t.isBlockStatement(init.body)) {
    // Every statement must be a const decl or the final return.
    const stmts = init.body.body;
    if (stmts.length === 0) return false;
    for (let i = 0; i < stmts.length - 1; i++) {
      if (!t.isVariableDeclaration(stmts[i]) || stmts[i].kind !== 'const') return false;
    }
    const ret = stmts[stmts.length - 1];
    if (!t.isReturnStatement(ret) || !ret.argument) return false;
  }
  if (decl.parentPath.node.kind !== 'const') return false;
  if (binding.constantViolations.length > 0) return false;
  if (!init.params.every((p) => t.isIdentifier(p))) return false;

  // All arguments must be statically evaluable (with scope resolution).
  if (node.arguments.length !== init.params.length) return false;
  const argValues = withScope(path.scope, () =>
    node.arguments.map((arg) => {
      if (t.isSpreadElement(arg)) return { confident: false };
      return evaluate(arg);
    })
  );
  if (argValues.some((ev) => !ev.confident)) return false;

  // Substitute params and evaluate the body.
  const subst = new Map();
  init.params.forEach((p, i) => subst.set(p.name, valueToNode(argValues[i].value)));

  const bodyResult = buildEvaluableBody(init.body, subst);
  if (!bodyResult) return false;

  const ev = withScope(path.scope, () => evaluate(bodyResult));
  if (!ev.confident) return false;

  // Only fold serializable results.
  if (
    typeof ev.value === 'string' ||
    typeof ev.value === 'number' ||
    typeof ev.value === 'boolean' ||
    ev.value === null ||
    ev.value === undefined ||
    Array.isArray(ev.value)
  ) {
    path.replaceWith(valueToNode(ev.value));
    return true;
  }

  return false;
}

/**
 * Build a single evaluable expression from a lambda body:
 *  - expression body -> substituted directly
 *  - block: const decls get evaluated into the substitution map, the
 *    final return expression is substituted and returned.
 * Returns the expression node or null.
 */
function buildEvaluableBody(body, subst) {
  // Expression body.
  if (!t.isBlockStatement(body)) {
    return cloneAndSubstitute(body, subst);
  }

  const stmts = body.body;
  const localSubst = new Map(subst);

  for (let i = 0; i < stmts.length - 1; i++) {
    const stmt = stmts[i];
    if (!t.isVariableDeclaration(stmt) || stmt.kind !== 'const') return null;
    for (const d of stmt.declarations) {
      if (!t.isIdentifier(d.id) || !d.init) return null;
      // The init may reference params or earlier locals — substitute first.
      const substituted = cloneAndSubstitute(d.init, localSubst);
      const ev = evaluate(substituted);
      if (!ev.confident) return null;
      localSubst.set(d.id.name, valueToNode(ev.value));
    }
  }

  const ret = stmts[stmts.length - 1];
  if (!t.isReturnStatement(ret) || !ret.argument) return null;

  return cloneAndSubstitute(ret.argument, localSubst);
}

/**
 * Deep-clone a node, replacing identifiers per the substitution map.
 */
function cloneAndSubstitute(node, subst) {
  if (!node) return node;
  if (t.isIdentifier(node)) {
    if (subst.has(node.name)) {
      return t.cloneNode(subst.get(node.name), true);
    }
    return t.identifier(node.name);
  }
  const fresh = {};
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      fresh[key] = value.map((v) => (v && typeof v === 'object' && v.type ? cloneAndSubstitute(v, subst) : v));
    } else if (value && typeof value === 'object' && value.type) {
      fresh[key] = cloneAndSubstitute(value, subst);
    } else {
      fresh[key] = value;
    }
  }
  return fresh;
}

module.exports = aliasFold;