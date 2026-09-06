'use strict';

const t = require('@babel/types');
const { evaluate, valueToNode, withScope, cloneAndSubstitute } = require('../evaluator');

/**
 * Pass: Proxy facade inlining.
 *
 * Obfuscators hide arithmetic behind a Proxy:
 *
 *   const 𝒪 = new Proxy({}, {
 *     get: (_, p) => ({ x: (a, b) => a ^ b, a: (a,b) => a + b, ... })[p]
 *   });
 *   𝒪.x(cipher[i], key)   ->  cipher[i] ^ key
 *
 * When the Proxy's get handler is a member lookup into an object literal of
 * arrow-function methods, every call `facade.prop(args)` is replaced by the
 * corresponding method body with arguments substituted (when the method is
 * an expression-bodied arrow), or by the method's bound expression.
 */
function inlineProxyFacade(ast) {
  const { traverse } = require('../utils');

  let changed = true;
  let iterations = 0;

  while (changed && iterations < 10) {
    changed = false;
    iterations++;

    traverse(ast, {
      NewExpression(path) {
        if (!t.isIdentifier(path.node.callee, { name: 'Proxy' })) return;
        if (path.node.arguments.length !== 2) return;
        const handler = path.node.arguments[1];
        if (!t.isObjectExpression(handler)) return;

        // Find the get handler.
        const getProp = handler.properties.find(
          (p) =>
            t.isObjectProperty(p) &&
            !p.computed &&
            t.isIdentifier(p.key, { name: 'get' })
        );
        if (!getProp || !t.isFunctionExpression(getProp.value) && !t.isArrowFunctionExpression(getProp.value)) return;

        const getBody = getProp.value.body;

        // ---- Identity proxy: get: (o, p) => Reflect.get(o, p) ----
        // Pure passthrough — the proxy is transparent. Replace every
        // facade member access with the target and remove the proxy.
        const handlerFn = getProp.value;
        const passthroughBody =
          (t.isBlockStatement(getProp.value.body) &&
            getProp.value.body.body.length === 1 &&
            t.isReturnStatement(getProp.value.body.body[0]) &&
            getProp.value.body.body[0].argument) ||
          (!t.isBlockStatement(getProp.value.body) && getProp.value.body);
        if (
          passthroughBody &&
          handlerFn.params.length === 2 &&
          handlerFn.params.every((p) => t.isIdentifier(p)) &&
          isReflectGetPassthrough(passthroughBody, handlerFn.params)
        ) {
          const target = path.node.arguments[0];
          if (t.isIdentifier(target) || t.isMemberExpression(target)) {
            const decl = path.parentPath;
            if (decl.isVariableDeclarator()) {
              const facadeBinding = path.scope.getBinding(decl.node.id.name);
              if (facadeBinding && facadeBinding.constantViolations.length === 0) {
                // Replace every facade member access: facade.prop -> target.prop
                let replaced = 0;
                let safe = true;
                for (const ref of facadeBinding.referencePaths) {
                  const member = ref.parent;
                  if (
                    t.isMemberExpression(member) &&
                    !member.computed &&
                    member.object === ref.node
                  ) {
                    ref.replaceWith(t.cloneNode(target, true));
                    replaced++;
                  } else {
                    safe = false; // bare facade use — leave everything
                  }
                }
                if (safe && replaced > 0) {
                  const declParent = decl.parentPath;
                  if (t.isVariableDeclaration(declParent.node) && declParent.node.declarations.length === 1) {
                    declParent.remove();
                  } else {
                    decl.remove();
                  }
                  changed = true;
                  return;
                }
              }
            }
          }
        }

        // get: (_, p) => ({ ...methods })[p]
        let methodsObject = null;
        if (t.isMemberExpression(getBody) && t.isObjectExpression(getBody.object)) {
          methodsObject = getBody.object;
        } else if (
          t.isBlockStatement(getBody) &&
          getBody.body.length === 1 &&
          t.isReturnStatement(getBody.body[0]) &&
          t.isMemberExpression(getBody.body[0].argument) &&
          t.isObjectExpression(getBody.body[0].argument.object)
        ) {
          methodsObject = getBody.body[0].argument.object;
        }
        if (!methodsObject) return;

        // Collect the method table: name -> arrow function.
        const methods = new Map();
        for (const prop of methodsObject.properties) {
          if (!t.isObjectProperty(prop) || prop.computed) return;
          const key = t.isIdentifier(prop.key) ? prop.key.name : t.isStringLiteral(prop.key) ? prop.key.value : null;
          if (!key) return;
          if (!t.isArrowFunctionExpression(prop.value) && !t.isFunctionExpression(prop.value)) return;
          methods.set(key, prop.value);
        }
        if (methods.size === 0) return;

        // Find who uses this facade: const F = new Proxy(...)
        const parentDecl = path.parentPath;
        if (!parentDecl.isVariableDeclarator()) return;
        const facadeName = parentDecl.node.id.name;
        const binding = path.scope.getBinding(facadeName);
        if (!binding || binding.constantViolations.length > 0) return;

        // Replace ONE facade call per visit via a fresh traversal (avoids
        // stale reference paths entirely). The outer while-loop re-runs
        // until every call is inlined.
        let done = false;
        path.scope.path.traverse({
          CallExpression(callPath) {
            if (done) return;
            const call = callPath.node;
            const callee = call.callee;
            if (
              !t.isMemberExpression(callee) ||
              callee.computed ||
              !t.isIdentifier(callee.object, { name: facadeName }) ||
              !t.isIdentifier(callee.property)
            ) {
              return;
            }
            const method = methods.get(callee.property.name);
            if (!method) return;
            if (method.params.length !== call.arguments.length) return;
            if (!method.params.every((p) => t.isIdentifier(p))) return;

            // Expression or single-return block body.
            let body = null;
            if (!t.isBlockStatement(method.body)) {
              body = method.body;
            } else if (
              method.body.body.length === 1 &&
              t.isReturnStatement(method.body.body[0]) &&
              method.body.body[0].argument
            ) {
              body = method.body.body[0].argument;
            }
            if (!body) return;

            const subst = new Map();
            method.params.forEach((p, i) => subst.set(p.name, call.arguments[i]));
            const inlinedBody = cloneAndSubstitute(body, subst);
            callPath.replaceWith(inlinedBody);
            changed = true;
            done = true; // one per visit — outer loop re-runs
          },
        });

        // Remove the facade when no references remain.
        if (done && countReferences(ast, facadeName) === 0) {
          const decl = parentDecl.parentPath;
          if (t.isVariableDeclaration(decl.node) && decl.node.declarations.length === 1) {
            decl.remove();
          } else {
            parentDecl.remove();
          }
        }
      },
    });
  }

  return ast;
}

/**
 * Count references to a name across the AST.
 */
function countReferences(ast, name) {
  const { traverse } = require('../utils');
  let count = 0;
  traverse(ast, {
    Identifier(path) {
      if (path.node.name === name && path.isReferencedIdentifier()) count++;
    },
  });
  return count;
}

/**
 * True for the passthrough expression: Reflect.get(o, p) where the args
 * are exactly the handler's two params, positionally.
 */
function isReflectGetPassthrough(node, params) {
  if (!t.isCallExpression(node)) return false;
  const callee = node.callee;
  if (
    !t.isMemberExpression(callee) ||
    !t.isIdentifier(callee.object, { name: 'Reflect' }) ||
    !t.isIdentifier(callee.property, { name: 'get' })
  ) {
    return false;
  }
  if (node.arguments.length !== 2) return false;
  return (
    t.isIdentifier(node.arguments[0], { name: params[0].name }) &&
    t.isIdentifier(node.arguments[1], { name: params[1].name })
  );
}

module.exports = inlineProxyFacade;