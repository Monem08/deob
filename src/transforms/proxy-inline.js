'use strict';

const t = require('@babel/types');

/**
 * Pass 4: Proxy function inlining.
 *
 * Detects simple wrapper functions that just return an expression or
 * delegate to another function, and inlines them at call sites.
 */
function inlineProxies(ast) {
  const { traverse } = require('../utils');

  // Collect candidate proxy functions.
  const proxies = new Map(); // name -> { path, params, returnArg }

  traverse(ast, {
    FunctionDeclaration(path) {
      const name = path.node.id && path.node.id.name;
      if (!name) return;
      const params = path.node.params;
      const body = path.node.body;

      // Single return statement body.
      if (t.isBlockStatement(body) && body.body.length === 1 && t.isReturnStatement(body.body[0])) {
        const arg = body.body[0].argument;
        if (arg) {
          proxies.set(name, { path, params, returnArg: arg });
        }
      }
    },
  });

  if (proxies.size === 0) return ast;

  let inlined = 0;
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee)) return;
      const proxy = proxies.get(callee.name);
      if (!proxy) return;

      // Skip the proxy's own declaration.
      if (path.findParent((p) => p === proxy.path)) return;

      const args = path.node.arguments;
      if (args.length !== proxy.params.length) return;

      // Build a substitution map from param name -> argument node.
      const subst = new Map();
      proxy.params.forEach((param, i) => {
        if (t.isIdentifier(param)) {
          subst.set(param.name, args[i]);
        }
      });

      // Clone the return expression and substitute params.
      const cloned = substitute(t.cloneNode(proxy.returnArg, true), subst);

      // Only inline if the result is a simple expression (avoid huge bloat).
      if (isSimpleExpression(cloned)) {
        path.replaceWith(cloned);
        inlined++;
      }
    },
  });

  // Remove unused proxies.
  if (inlined > 0) {
    for (const proxy of proxies.values()) {
      if (countReferences(ast, proxy.path.node.id.name) === 0) {
        proxy.path.remove();
      }
    }
  }

  return ast;
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

/**
 * Recursively substitute identifiers in a node tree.
 */
function substitute(node, subst) {
  if (!node || subst.size === 0) return node;

  if (t.isIdentifier(node) && subst.has(node.name)) {
    return t.cloneNode(subst.get(node.name), true);
  }

  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue;
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

function isSimpleExpression(node) {
  if (!node) return false;
  if (t.isLiteral(node) || t.isIdentifier(node)) return true;
  if (t.isMemberExpression(node)) return isSimpleExpression(node.object);
  if (t.isUnaryExpression(node)) return isSimpleExpression(node.argument);
  if (t.isBinaryExpression(node) || t.isLogicalExpression(node)) {
    return isSimpleExpression(node.left) && isSimpleExpression(node.right);
  }
  if (t.isCallExpression(node)) {
    return isSimpleExpression(node.callee) && node.arguments.every(isSimpleExpression);
  }
  return false;
}

module.exports = inlineProxies;
