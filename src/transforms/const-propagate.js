'use strict';

const t = require('@babel/types');
const { evaluate } = require('../evaluator');

/**
 * Pass: Constant propagation.
 *
 * Replaces every reference to a const-bound variable whose value is a
 * small evaluable primitive with the literal itself, then lets dead-code
 * passes clean up the now-unused declarations.
 *
 *   const _console = _str([99, 111, ...]);   // folded to "console" earlier
 *   obj[_console].log(...)                   // -> obj["console"].log(...)
 *
 * Limits: primitives only (string/number/boolean/null), value size capped,
 * reference count capped, no self-references.
 */
function constantPropagation(ast) {
  const { traverse } = require('../utils');

  let changed = true;
  let iterations = 0;

  while (changed && iterations < 10) {
    changed = false;
    iterations++;

    traverse(ast, {
      Program(programPath) {
        // Refresh scope info so reference counts reflect prior replacements.
        try {
          programPath.scope.crawl();
        } catch (e) {
          // ignore crawl failures on damaged scopes
        }
      },
      Scope(scopePath) {
        for (const binding of Object.values(scopePath.scope.bindings)) {
          if (!binding.path || !binding.path.isVariableDeclarator()) continue;
          if (binding.constantViolations.length > 0) continue;
          const decl = binding.path.parentPath;
          if (!decl || !t.isVariableDeclaration(decl.node) || decl.node.kind !== 'const') continue;
          if (binding.referenced === false) continue;

          const init = binding.path.node.init;
          if (!init) continue;

          // Case 1: identifier alias — const a = b -> replace uses of a with b.
          if (t.isIdentifier(init)) {
            const aliasBinding = scopePath.scope.getBinding(init.name);
            // Unresolvable identifiers (globals like globalThis) are fine to
            // alias — the binding never gets reassigned by definition of scope.
            if (!aliasBinding || aliasBinding.constantViolations.length === 0) {
              const refs = binding.referencePaths;
              if (refs.length === 0 || refs.length > 8) continue;
              let replaced = 0;
              for (const ref of refs) {
                try {
                  ref.replaceWith(t.cloneNode(init, true));
                  replaced++;
                } catch (e) {
                  // skip unreplaceable positions
                }
              }
              if (replaced === refs.length) {
                changed = true;
              }
            }
            continue;
          }

          // Case 2: primitives only.
          if (
            !t.isStringLiteral(init) &&
            !t.isNumericLiteral(init) &&
            !t.isBooleanLiteral(init) &&
            !t.isNullLiteral(init)
          ) {
            continue;
          }

          // Size and reference caps to avoid pathological blowup.
          const refs = binding.referencePaths;
          if (refs.length === 0 || refs.length > 8) continue;
          if (t.isStringLiteral(init) && init.value.length > 128) continue;

          // Replace every reference with the literal.
          let replaced = 0;
          for (const ref of refs) {
            try {
              ref.replaceWith(t.cloneNode(init, true));
              replaced++;
            } catch (e) {
              // skip unreplaceable positions (for-init heads etc.)
            }
          }

          if (replaced === refs.length) {
            changed = true;
          }
        }
      },
    });
  }

  return ast;
}

module.exports = constantPropagation;