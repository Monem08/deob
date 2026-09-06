'use strict';

const t = require('@babel/types');
const { evaluate, valueToNode, withScope, cloneAndSubstitute } = require('../evaluator');

/**
 * Pass 2: String array decoder.
 *
 * Detects the common obfuscation pattern:
 *   var _0xabc = ['hello', 'world', ...];
 *   function _0xdef(idx, key) { ... rotate/shift ... return _0xabc[idx - offset]; }
 *   _0xdef('0x1')  ->  'hello'
 *
 * Resolves calls to the decoder function into their string literals,
 * then removes the now-unused array and decoder function.
 */
function decodeStringArray(ast) {
  const { traverse } = require('../utils');

  // Collect candidate string arrays: variable declarations initialized to an array of strings.
  const stringArrays = new Map(); // bindingName -> { path, values: string[] }

  traverse(ast, {
    VariableDeclarator(path) {
      const id = path.node.id;
      const init = path.node.init;
      if (!t.isIdentifier(id) || !t.isArrayExpression(init)) return;

      const values = [];
      let allStrings = true;
      for (const el of init.elements) {
        if (el === null) { allStrings = false; break; }
        const ev = evaluate(el);
        if (!ev.confident || typeof ev.value !== 'string') { allStrings = false; break; }
        values.push(ev.value);
      }
      if (allStrings && values.length > 0) {
        stringArrays.set(id.name, { path, values, binding: path.scope.getBinding(id.name) });
      }
    },
  });

  if (stringArrays.size === 0) return ast;

  // Detect rotation IIFEs that mutate the array before use:
  //   (function(arr, count) {
  //     var fn = function(n) { while (--n) { arr.push(arr.shift()); } };
  //     fn(++count);
  //   })(_0x9a0b, 0x1a3);
  const rotations = new Map(); // arrayName -> rotation count
  const rotationPaths = []; // IIFE paths to remove after applying

  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isFunctionExpression(callee) && !t.isArrowFunctionExpression(callee)) return;
      const args = path.node.arguments;
      if (args.length < 2) return;
      const arrArg = args[0];
      if (!t.isIdentifier(arrArg) || !stringArrays.has(arrArg.name)) return;
      const countArg = evaluate(args[1]);
      if (!countArg.confident || typeof countArg.value !== 'number') return;

      // Confirm the function body contains a shift/push rotation loop.
      let hasRotation = false;
      path.traverse({
        CallExpression(inner) {
          const c = inner.node.callee;
          if (t.isMemberExpression(c) && isMemberName(c, 'shift')) {
            hasRotation = true;
          }
        },
      });

      if (!hasRotation) return;

      // Three rotation shapes exist:
      //   A) helper called with ++count  -> loops `count` times
      //      (function(a, n) { var f = function(m) { while (--m) {...} }; f(++n); })(arr, 0x1a3)
      //   B) while (--n) directly -> pre-decrement, loops `count - 1` times
      //      (function(a, n) { while (--n) {...} })(arr, 0x1337)
      //   C) while (n--) directly -> post-decrement, loops `count` times
      //      (function(a, n) { while (n--) {...} })(arr, 3)
      let usesIncrementedArg = false;
      let whileTest = null;
      path.traverse({
        CallExpression(inner) {
          if (inner.node === path.node) return;
          for (const arg of inner.node.arguments) {
            if (
              t.isUpdateExpression(arg) &&
              arg.operator === '++' &&
              t.isIdentifier(arg.argument)
            ) {
              usesIncrementedArg = true;
            }
          }
        },
        WhileStatement(inner) {
          if (inner.node.test.type === 'UpdateExpression') {
            whileTest = inner.node.test;
          }
        },
      });

      let rawCount;
      if (usesIncrementedArg) {
        rawCount = countArg.value;
      } else if (whileTest && whileTest.prefix) {
        rawCount = countArg.value - 1; // --n: runs count-1 times
      } else {
        rawCount = countArg.value; // n--: runs count times
      }

      const len = stringArrays.get(arrArg.name).values.length;
      const rotation = ((rawCount % len) + len) % len;
      rotations.set(arrArg.name, rotation);
      rotationPaths.push(path);
    },
  });

  // Apply rotations to the stored values AND bake them into the AST's
  // array literal, so later rounds (which re-parse the source) collect
  // the already-rotated values consistently.
  for (const [name, rotation] of rotations) {
    const arr = stringArrays.get(name);
    if (!arr) continue;
    const values = arr.values;
    for (let i = 0; i < rotation; i++) {
      values.push(values.shift());
    }

    // Rewrite the array literal in the AST to the rotated order.
    const literal = arr.path.node.init;
    if (t.isArrayExpression(literal)) {
      const rotated = [...literal.elements];
      for (let i = 0; i < rotation; i++) rotated.push(rotated.shift());
      literal.elements = rotated;
    }
  }

  // Remove the rotation IIFEs (their effect is now baked into the values).
  for (const path of rotationPaths) {
    const parent = path.parentPath;
    if (parent && t.isExpressionStatement(parent.node)) {
      parent.remove();
    } else {
      path.remove();
    }
  }

  // Find decoder functions that reference one of these arrays.
  const decoders = new Map(); // functionName -> { path, arrayName, values, offset }

  traverse(ast, {
    FunctionDeclaration(path) {
      const fnName = path.node.id && path.node.id.name;
      if (!fnName) return;

      let referencedArray = null;
      path.traverse({
        Identifier(inner) {
          if (inner.isReferencedIdentifier() && stringArrays.has(inner.node.name)) {
            referencedArray = stringArrays.get(inner.node.name);
          }
        },
      });

      if (!referencedArray) return;

      // Determine the offset: look for a numeric literal subtracted from the index.
      let offset = 0;
      path.traverse({
        BinaryExpression(inner) {
          if (inner.node.operator === '-') {
            const right = evaluate(inner.node.right);
            if (right.confident && typeof right.value === 'number') {
              offset = right.value;
            }
          }
        },
      });

      decoders.set(fnName, {
        path,
        arrayName: referencedArray.path.node.id.name,
        values: referencedArray.values,
        offset,
      });
    },
  });

  // Also detect arrow-function decoders assigned to a variable:
  //   const _0xdecode = (i) => _0x4f91[(i ^ 0x2a) % _0x4f91.length];
  // Resolution is generic: the call argument is substituted into the body
  // expression along with the array's concrete values, then evaluated.
  traverse(ast, {
    VariableDeclarator(path) {
      const id = path.node.id;
      const init = path.node.init;
      if (!t.isIdentifier(id) || !t.isArrowFunctionExpression(init)) return;
      if (t.isBlockStatement(init.body)) return;
      if (init.params.length !== 1 || !t.isIdentifier(init.params[0])) return;

      let referencedArray = null;
      path.traverse({
        Identifier(inner) {
          if (inner.isReferencedIdentifier() && stringArrays.has(inner.node.name)) {
            referencedArray = stringArrays.get(inner.node.name);
          }
        },
      });

      if (!referencedArray) return;

      decoders.set(id.name, {
        path,
        arrayName: referencedArray.path.node.id.name,
        values: referencedArray.values,
        offset: 0,
        isArrow: true,
      });
    },
  });

  if (decoders.size === 0) return ast;

  // Resolve decoder calls.
  let resolved = 0;
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee)) return;
      const decoder = decoders.get(callee.name);
      if (!decoder) return;

      // Skip calls inside the decoder function itself.
      if (path.findParent((p) => p === decoder.path)) return;

      const args = path.node.arguments;
      if (args.length === 0) return;

      // Arrow decoder: substitute arg + array values into the body and
      // evaluate generically (handles any index expression shape).
      if (decoder.isArrow) {
        const ev = withScope(path.scope, () => evaluate(args[0]));
        if (!ev.confident) return;

        const init = decoder.path.node.init;
        const subst = new Map();
        subst.set(init.params[0].name, valueToNode(ev.value));
        subst.set(decoder.arrayName, valueToNode(decoder.values));

        const body = cloneAndSubstitute(init.body, subst);
        const bodyEv = withScope(path.scope, () => evaluate(body));
        if (bodyEv.confident && typeof bodyEv.value === 'string') {
          path.replaceWith(t.stringLiteral(bodyEv.value));
          resolved++;
        }
        return;
      }

      const idxArg = withScope(path.scope, () => evaluate(args[0]));
      if (!idxArg.confident) return;

      let index;
      if (typeof idxArg.value === 'number') {
        index = idxArg.value - decoder.offset;
      } else if (typeof idxArg.value === 'string') {
        // Hex string like '0x1'
        const parsed = parseInt(idxArg.value, 16);
        if (Number.isNaN(parsed)) return;
        index = parsed - decoder.offset;
      } else {
        return;
      }

      if (index < 0 || index >= decoder.values.length) return;

      path.replaceWith(t.stringLiteral(decoder.values[index]));
      resolved++;
    },
  });

  // Resolve direct array indexing with a constant index:
  //   _0x4f91[0]  ->  'log'
  //   _0x4f91[(i ^ 0x2a) % _0x4f91.length]  ->  resolved when index is constant
  traverse(ast, {
    MemberExpression(path) {
      if (!path.node.computed) return;
      const obj = path.node.object;
      if (!t.isIdentifier(obj)) return;
      const arr = stringArrays.get(obj.name);
      if (!arr) return;

      const idx = evaluate(path.node.property);
      if (!idx.confident || typeof idx.value !== 'number') return;
      if (idx.value < 0 || idx.value >= arr.values.length) return;

      path.replaceWith(t.stringLiteral(arr.values[idx.value]));
      resolved++;
    },
  });

  // Remove decoder functions and string arrays that are no longer referenced.
  for (const decoder of decoders.values()) {
    if (countReferences(ast, decoder.path.node.id.name) === 0) {
      decoder.path.remove();
    }
  }
  for (const arr of stringArrays.values()) {
    if (countReferences(ast, arr.path.node.id.name) === 0) {
      arr.path.remove();
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
 * Check if a member expression's property matches a name, whether
 * accessed via dot notation or a string literal in computed notation.
 */
function isMemberName(memberExpr, name) {
  if (!t.isMemberExpression(memberExpr)) return false;
  if (!memberExpr.computed && t.isIdentifier(memberExpr.property, { name })) return true;
  if (memberExpr.computed && t.isStringLiteral(memberExpr.property, { value: name })) return true;
  return false;
}

module.exports = decodeStringArray;
