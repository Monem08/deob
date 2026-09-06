'use strict';

const t = require('@babel/types');

/**
 * typeof results for well-known globals (Node + browser baseline).
 * Used to fold environment probes like `typeof atob === 'function'`.
 */
const KNOWN_GLOBAL_TYPES = new Map([
  ['atob', 'function'],
  ['btoa', 'function'],
  ['console', 'object'],
  ['Buffer', 'function'],
  ['TextDecoder', 'function'],
  ['TextEncoder', 'function'],
  ['globalThis', 'object'],
  ['global', 'object'],
  ['window', 'object'],
  ['document', 'object'],
  ['Math', 'object'],
  ['JSON', 'object'],
  ['Object', 'function'],
  ['Array', 'function'],
  ['String', 'function'],
  ['Number', 'function'],
  ['Boolean', 'function'],
  ['Function', 'function'],
  ['Symbol', 'function'],
  ['Promise', 'function'],
  ['Uint8Array', 'function'],
  ['undefined', 'undefined'],
  ['NaN', 'number'],
  ['Infinity', 'number'],
]);

/**
 * Ambient scope for identifier resolution. Passes that own a path set this
 * before calling evaluate(); recursion inherits it automatically.
 */
let currentScope = null;

/**
 * Evaluate a node to a concrete value when it is statically resolvable.
 * Returns { confident: boolean, value: any }.
 */
function evaluate(node) {
  if (!node) return { confident: false, value: undefined };

  // Literals
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) {
    return { confident: true, value: node.value };
  }

  // Bound identifier resolution (ambient scope).
  // Primitives always resolve. Arrays/objects only resolve when the
  // binding is provably never mutated (no push/element-write anywhere).
  if (t.isIdentifier(node) && currentScope) {
    const resolved = resolveConstBinding(node.name);
    if (resolved) {
      const isPrimitiveInit =
        t.isStringLiteral(resolved) ||
        t.isNumericLiteral(resolved) ||
        t.isBooleanLiteral(resolved) ||
        t.isNullLiteral(resolved) ||
        t.isBigIntLiteral(resolved);

      if (isPrimitiveInit) {
        return evaluate(resolved);
      }

      const binding = currentScope.getBinding(node.name);
      if (binding && !bindingIsMutated(binding)) {
        const ev = evaluate(resolved);
        if (ev.confident) return ev;
      }
    }
  }
  if (t.isNullLiteral(node)) return { confident: true, value: null };
  if (t.isBigIntLiteral(node)) return { confident: true, value: BigInt(node.value) };

  // typeof <known global> — resolvable without evaluating the operand.
  // Must run before the generic unary branch (which bails on unknowns).
  if (
    t.isUnaryExpression(node, { operator: 'typeof' }) &&
    t.isIdentifier(node.argument) &&
    KNOWN_GLOBAL_TYPES.has(node.argument.name)
  ) {
    return { confident: true, value: KNOWN_GLOBAL_TYPES.get(node.argument.name) };
  }

  // typeof <function expression / arrow> — always 'function'.
  if (
    t.isUnaryExpression(node, { operator: 'typeof' }) &&
    (t.isArrowFunctionExpression(node.argument) ||
      t.isFunctionExpression(node.argument) ||
      t.isClassExpression(node.argument))
  ) {
    return { confident: true, value: 'function' };
  }

  // Unary expressions
  if (t.isUnaryExpression(node)) {
    const arg = evaluate(node.argument);
    if (!arg.confident) return { confident: false, value: undefined };
    switch (node.operator) {
      case '!': return { confident: true, value: !arg.value };
      case '-': return { confident: true, value: -arg.value };
      case '+': return { confident: true, value: +arg.value };
      case '~': return { confident: true, value: ~arg.value };
      case 'typeof': return { confident: true, value: typeof arg.value };
      case 'void': return { confident: true, value: undefined };
      default: return { confident: false, value: undefined };
    }
  }

  // typeof <known global> — resolvable without evaluating the operand.
  if (
    t.isUnaryExpression(node, { operator: 'typeof' }) &&
    t.isIdentifier(node.argument) &&
    KNOWN_GLOBAL_TYPES.has(node.argument.name)
  ) {
    return { confident: true, value: KNOWN_GLOBAL_TYPES.get(node.argument.name) };
  }

  // Binary expressions
  if (t.isBinaryExpression(node)) {
    const left = evaluate(node.left);
    const right = evaluate(node.right);
    if (!left.confident || !right.confident) return { confident: false, value: undefined };
    const l = left.value;
    const r = right.value;
    try {
      switch (node.operator) {
        case '+': return { confident: true, value: l + r };
        case '-': return { confident: true, value: l - r };
        case '*': return { confident: true, value: l * r };
        case '/': return { confident: true, value: l / r };
        case '%': return { confident: true, value: l % r };
        case '**': return { confident: true, value: l ** r };
        case '<<': return { confident: true, value: l << r };
        case '>>': return { confident: true, value: l >> r };
        case '>>>': return { confident: true, value: l >>> r };
        case '&': return { confident: true, value: l & r };
        case '|': return { confident: true, value: l | r };
        case '^': return { confident: true, value: l ^ r };
        case '==': return { confident: true, value: l == r };
        case '!=': return { confident: true, value: l != r };
        case '===': return { confident: true, value: l === r };
        case '!==': return { confident: true, value: l !== r };
        case '<': return { confident: true, value: l < r };
        case '<=': return { confident: true, value: l <= r };
        case '>': return { confident: true, value: l > r };
        case '>=': return { confident: true, value: l >= r };
        default: return { confident: false, value: undefined };
      }
    } catch (e) {
      return { confident: false, value: undefined };
    }
  }

  // Logical expressions
  if (t.isLogicalExpression(node)) {
    const left = evaluate(node.left);
    if (!left.confident) return { confident: false, value: undefined };
    if (node.operator === '&&') {
      if (!left.value) return { confident: true, value: left.value };
      const right = evaluate(node.right);
      return right.confident ? { confident: true, value: right.value } : { confident: false, value: undefined };
    }
    if (node.operator === '||') {
      if (left.value) return { confident: true, value: left.value };
      const right = evaluate(node.right);
      return right.confident ? { confident: true, value: right.value } : { confident: false, value: undefined };
    }
    if (node.operator === '??') {
      if (left.value !== null && left.value !== undefined) return { confident: true, value: left.value };
      const right = evaluate(node.right);
      return right.confident ? { confident: true, value: right.value } : { confident: false, value: undefined };
    }
  }

  // Conditional expression
  if (t.isConditionalExpression(node)) {
    const test = evaluate(node.test);
    if (!test.confident) return { confident: false, value: undefined };
    return evaluate(test.value ? node.consequent : node.alternate);
  }

  // Template literal with no expressions
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
    return { confident: true, value: node.quasis.map((q) => q.value.cooked).join('') };
  }

  // Array expression
  if (t.isArrayExpression(node)) {
    const arr = [];
    for (const el of node.elements) {
      if (el === null) {
        arr.length += 1; // hole
        continue;
      }
      if (t.isSpreadElement(el)) {
        const ev = evaluate(el.argument);
        if (!ev.confident) return { confident: false, value: undefined };
        if (Array.isArray(ev.value)) arr.push(...ev.value);
        else if (typeof ev.value === 'string') arr.push(...ev.value);
        else return { confident: false, value: undefined };
        continue;
      }
      const ev = evaluate(el);
      if (!ev.confident) return { confident: false, value: undefined };
      arr.push(ev.value);
    }
    return { confident: true, value: arr };
  }

  // Object expression
  if (t.isObjectExpression(node)) {
    const obj = {};
    for (const prop of node.properties) {
      if (!t.isObjectProperty(prop) || prop.computed) return { confident: false, value: undefined };
      const key = t.isIdentifier(prop.key) ? prop.key.name : t.isStringLiteral(prop.key) ? prop.key.value : null;
      if (key === null) return { confident: false, value: undefined };
      const ev = evaluate(prop.value);
      if (!ev.confident) return { confident: false, value: undefined };
      obj[key] = ev.value;
    }
    return { confident: true, value: obj };
  }

  // Member access on constant strings: 'abc'.length, 'abc'[1],
  // and identifiers evaluating to constant strings (v1.length).
  // Handles both .length and ['length'] computed access.
  if (t.isMemberExpression(node)) {
    let isLengthProp = false;
    if (!node.computed && t.isIdentifier(node.property, { name: 'length' })) isLengthProp = true;
    else if (node.computed && t.isStringLiteral(node.property, { value: 'length' })) isLengthProp = true;

    if (isLengthProp) {
      if (t.isStringLiteral(node.object)) {
        return { confident: true, value: node.object.value.length };
      }
      if (t.isIdentifier(node.object) && currentScope) {
        const objEv = evaluate(resolveConstBindingShallow(node.object.name));
        if (objEv.confident && typeof objEv.value === 'string') {
          return { confident: true, value: objEv.value.length };
        }
      }
    }
  }
  if (t.isMemberExpression(node) && t.isStringLiteral(node.object) && node.computed) {
    const prop = evaluate(node.property);
    if (prop.confident) {
      if (typeof prop.value === 'number') {
        const ch = node.object.value[prop.value];
        if (ch !== undefined) return { confident: true, value: ch };
      } else if (prop.value === 'length') {
        return { confident: true, value: node.object.value.length };
      }
    }
  }
  // Computed member on identifier-resolved constant string: v1[i]
  if (t.isMemberExpression(node) && node.computed && t.isIdentifier(node.object) && currentScope) {
    const objEv = evaluate(resolveConstBindingShallow(node.object.name));
    if (objEv.confident && typeof objEv.value === 'string') {
      const prop = evaluate(node.property);
      if (prop.confident && typeof prop.value === 'number') {
        const ch = objEv.value[prop.value];
        if (ch !== undefined) return { confident: true, value: ch };
      }
    }
  }

  // Constant arrays: [..].length, [..][0]
  if (t.isMemberExpression(node) && t.isArrayExpression(node.object)) {
    const arrEv = evaluate(node.object);
    if (arrEv.confident && Array.isArray(arrEv.value)) {
      if (!node.computed && t.isIdentifier(node.property, { name: 'length' })) {
        return { confident: true, value: arrEv.value.length };
      }
      if (node.computed) {
        const prop = evaluate(node.property);
        if (prop.confident && typeof prop.value === 'number') {
          const el = arrEv.value[prop.value];
          if (el !== undefined) return { confident: true, value: el };
        }
      }
    }
  }

  // Computed member on identifier-bound constant array: reg[3], mem[i].
  // Gated by the mutation scan — element writes or push/splice anywhere
  // in the scope disallow resolution.
  if (
    t.isMemberExpression(node) &&
    node.computed &&
    t.isIdentifier(node.object) &&
    currentScope
  ) {
    const binding = currentScope.getBinding(node.object.name);
    if (binding && !bindingIsMutated(binding)) {
      const resolved = resolveConstBindingShallow(node.object.name);
      if (resolved) {
        const arrEv = evaluate(resolved);
        if (arrEv.confident && Array.isArray(arrEv.value)) {
          const prop = evaluate(node.property);
          if (prop.confident && typeof prop.value === 'number') {
            const el = arrEv.value[prop.value];
            if (el !== undefined) return { confident: true, value: el };
          }
          if (prop.confident && prop.value === 'length') {
            return { confident: true, value: arrEv.value.length };
          }
        }
      }
    }
  }

  // Call expressions for known pure builtins.
  if (t.isCallExpression(node)) {
    let callee = node.callee;

    // Follow alias chains: v0 = atob;  v0("...")  ->  atob("...")
    if (t.isIdentifier(callee) && currentScope) {
      let depth = 0;
      let cur = callee;
      while (t.isIdentifier(cur) && depth < 4) {
        const resolved = resolveConstBinding(cur.name);
        if (resolved && t.isIdentifier(resolved)) {
          cur = resolved;
          depth++;
        } else {
          break;
        }
      }
      if (t.isIdentifier(cur) && cur !== callee) {
        callee = cur;
      }
    }

    // String.fromCharCode(...) — supports spread of constant arrays.
    if (
      t.isMemberExpression(callee) &&
      t.isIdentifier(callee.object, { name: 'String' }) &&
      isMemberName(callee, 'fromCharCode')
    ) {
      const codes = [];
      for (const arg of node.arguments) {
        if (t.isSpreadElement(arg)) {
          const spread = evaluate(arg.argument);
          if (!spread.confident || !Array.isArray(spread.value)) return { confident: false, value: undefined };
          codes.push(...spread.value);
          continue;
        }
        const ev = evaluate(arg);
        if (!ev.confident || typeof ev.value !== 'number') return { confident: false, value: undefined };
        codes.push(ev.value);
      }
      return { confident: true, value: String.fromCharCode(...codes) };
    }

    // String.fromCodePoint(...)
    if (
      t.isMemberExpression(callee) &&
      t.isIdentifier(callee.object, { name: 'String' }) &&
      isMemberName(callee, 'fromCodePoint')
    ) {
      const codes = [];
      for (const arg of node.arguments) {
        if (t.isSpreadElement(arg)) {
          const spread = evaluate(arg.argument);
          if (!spread.confident || !Array.isArray(spread.value)) return { confident: false, value: undefined };
          codes.push(...spread.value);
          continue;
        }
        const ev = evaluate(arg);
        if (!ev.confident || typeof ev.value !== 'number') return { confident: false, value: undefined };
        codes.push(ev.value);
      }
      return { confident: true, value: String.fromCodePoint(...codes) };
    }

    // Array.from({ length: n }, (_, i) => <const>) — the s-box init idiom.
    if (
      t.isMemberExpression(callee) &&
      t.isIdentifier(callee.object, { name: 'Array' }) &&
      !callee.computed &&
      t.isIdentifier(callee.property, { name: 'from' })
    ) {
      const arg0 = node.arguments[0];
      if (arg0 && t.isObjectExpression(arg0)) {
        const lenProp = arg0.properties.find(
          (p) =>
            t.isObjectProperty(p) &&
            !p.computed &&
            t.isIdentifier(p.key, { name: 'length' })
        );
        if (lenProp) {
          const lenEv = evaluate(lenProp.value);
          if (lenEv.confident && typeof lenEv.value === 'number' && lenEv.value >= 0) {
            const mapper = node.arguments[1];
            if (mapper && (t.isArrowFunctionExpression(mapper) || t.isFunctionExpression(mapper))) {
              const out = evalArrayFromMapper(lenEv.value, mapper);
              if (out !== null) return { confident: true, value: out };
            }
          }
        }
      }
    }

    // Pure string methods on constant strings:
    //   'a|b|c'.split('|'), 'abc'.toUpperCase(), ...
    // Also identifiers resolving to constant strings (v1.charCodeAt(i)).
    // Accepts both dot notation and computed 'name' string-literal access.
    if (t.isMemberExpression(callee)) {
      // Resolve the property name.
      let methodName = null;
      if (!callee.computed && t.isIdentifier(callee.property)) {
        methodName = callee.property.name;
      } else if (callee.computed && t.isStringLiteral(callee.property)) {
        methodName = callee.property.value;
      }

      if (methodName && STRING_METHODS.has(methodName)) {
        let strNode = callee.object;
        if (t.isIdentifier(strNode) && currentScope) {
          const resolved = resolveConstBinding(strNode.name);
          if (resolved) strNode = resolved;
        }
        if (t.isStringLiteral(strNode)) {
          const argVals = [];
          let argsOk = true;
          for (const arg of node.arguments) {
            const ev = evaluate(arg);
            if (!ev.confident) { argsOk = false; break; }
            argVals.push(ev.value);
          }
          if (argsOk) {
            try {
              const fn = String.prototype[methodName];
              const result = fn.apply(strNode.value, argVals);
              if (
                typeof result === 'string' ||
                typeof result === 'number' ||
                typeof result === 'boolean' ||
                Array.isArray(result)
              ) {
                return { confident: true, value: result };
              }
            } catch (e) {
              return { confident: false, value: undefined };
            }
          }
        }
      }
    }

  // Array.prototype methods on constant arrays: [1,2,3].join('|'), etc.
  // Identifiers resolve ONLY when provably not mutated (push/splice/etc.
  // anywhere in the scope would make static folding observe stale state).
  if (t.isMemberExpression(callee) && !callee.computed) {
    let arrNode = callee.object;
    if (t.isIdentifier(arrNode) && currentScope) {
      const binding = currentScope.getBinding(arrNode.name);
      if (!binding || bindingIsMutated(binding)) return { confident: false, value: undefined };
      const resolved = resolveConstBinding(arrNode.name);
      if (resolved) arrNode = resolved;
    }
    if (t.isArrayExpression(arrNode)) {
      const arrEv = evaluate(arrNode);
      if (arrEv.confident && Array.isArray(arrEv.value)) {
        const methodName = t.isIdentifier(callee.property) ? callee.property.name : null;

        // Lambda-evaluating methods: map / reduce / forEach / filter.
        if (methodName && LAMBDA_ARRAY_METHODS.has(methodName)) {
          const lambda = node.arguments[0];
          if (lambda && (t.isArrowFunctionExpression(lambda) || t.isFunctionExpression(lambda))) {
            const out = evalArrayLambda(arrEv.value, methodName, lambda, node.arguments[1]);
            if (out !== null) return { confident: true, value: out };
          }
        }

        if (methodName && ARRAY_METHODS.has(methodName)) {
          const argVals = [];
          for (const arg of node.arguments) {
            const ev = evaluate(arg);
            if (!ev.confident) return { confident: false, value: undefined };
            argVals.push(ev.value);
          }
          try {
            const fn = Array.prototype[methodName];
            const result = fn.apply(arrEv.value, argVals);
            if (
              typeof result === 'string' ||
              typeof result === 'number' ||
              typeof result === 'boolean' ||
              Array.isArray(result)
            ) {
              return { confident: true, value: result };
            }
          } catch (e) {
            return { confident: false, value: undefined };
          }
        }
      }
    }
  }

    // Pure Math functions: Math.imul(a, b), Math.abs(x), ...
    if (
      t.isMemberExpression(callee) &&
      !callee.computed &&
      t.isIdentifier(callee.object, { name: 'Math' })
    ) {
      const methodName = t.isIdentifier(callee.property) ? callee.property.name : null;
      if (methodName && typeof Math[methodName] === 'function') {
        const argVals = [];
        for (const arg of node.arguments) {
          const ev = evaluate(arg);
          if (!ev.confident || typeof ev.value !== 'number') {
            return { confident: false, value: undefined };
          }
          argVals.push(ev.value);
        }
        try {
          const result = Math[methodName](...argVals);
          if (typeof result === 'number' && Number.isFinite(result)) {
            return { confident: true, value: result };
          }
        } catch (e) {
          return { confident: false, value: undefined };
        }
      }
    }

    // atob(s) — pure base64 decode of a constant string.
    if (t.isIdentifier(callee, { name: 'atob' }) && node.arguments.length === 1) {
      const ev = evaluate(node.arguments[0]);
      if (!ev.confident || typeof ev.value !== 'string') return { confident: false, value: undefined };
      try {
        const decoded = Buffer.from(ev.value, 'base64').toString('binary');
        return { confident: true, value: decoded };
      } catch (e) {
        return { confident: false, value: undefined };
      }
    }

    // parseInt / parseFloat
    if (t.isIdentifier(callee, { name: 'parseInt' }) && node.arguments.length >= 1) {
      const ev = evaluate(node.arguments[0]);
      if (!ev.confident) return { confident: false, value: undefined };
      const radix = node.arguments[1] ? evaluate(node.arguments[1]) : { confident: true, value: undefined };
      if (!radix.confident) return { confident: false, value: undefined };
      const parsed = parseInt(ev.value, radix.value);
      if (Number.isNaN(parsed)) return { confident: false, value: undefined };
      return { confident: true, value: parsed };
    }
    if (t.isIdentifier(callee, { name: 'parseFloat' }) && node.arguments.length >= 1) {
      const ev = evaluate(node.arguments[0]);
      if (!ev.confident) return { confident: false, value: undefined };
      const parsed = parseFloat(ev.value);
      if (Number.isNaN(parsed)) return { confident: false, value: undefined };
      return { confident: true, value: parsed };
    }
  }

  return { confident: false, value: undefined };
}

const STRING_METHODS = new Set([
  'split', 'charAt', 'charCodeAt', 'codePointAt', 'toUpperCase', 'toLowerCase',
  'trim', 'trimStart', 'trimEnd', 'slice', 'substring', 'substr', 'concat',
  'indexOf', 'lastIndexOf', 'includes', 'startsWith', 'endsWith', 'repeat',
  'padStart', 'padEnd', 'replace', 'replaceAll', 'at', 'localeCompare',
  'normalize', 'toString',
]);

const ARRAY_METHODS = new Set([
  'join', 'indexOf', 'lastIndexOf', 'includes', 'at', 'toString',
  'reverse', 'slice', 'concat', 'flat',
]);

const LAMBDA_ARRAY_METHODS = new Set(['map', 'reduce', 'filter', 'forEach']);

/**
 * Evaluate Array.from({ length: n }, (_, i) => expr).
 * The mapper must be a single-expression arrow whose body evaluates
 * statically for every (undefined, i) pair. Returns null on failure.
 */
function evalArrayFromMapper(length, mapper) {
  const body = getLambdaBody(mapper);
  const params = mapper.params;
  if (!body || params.length < 1 || params.length > 2) return null;
  if (!params.every((p) => t.isIdentifier(p))) return null;

  const out = [];
  for (let i = 0; i < length; i++) {
    const subst = new Map();
    subst.set(params[0].name, null); // undefined element
    if (params[1]) subst.set(params[1].name, t.numericLiteral(i));
    const ev = evaluateLambdaBody(body, subst);
    if (!ev.confident) return null;
    out.push(ev.value);
  }
  return out;
}

/**
 * Evaluate arr.map(fn), arr.reduce(fn, init), arr.filter(fn), arr.forEach(fn)
 * on a concrete array with a constant lambda. Returns null on failure.
 */
function evalArrayLambda(arr, methodName, lambda, secondArg) {
  const body = getLambdaBody(lambda);
  const params = lambda.params;
  if (!body || !params.every((p) => t.isIdentifier(p))) return null;

  try {
    if (methodName === 'map') {
      if (params.length < 1 || params.length > 3) return null;
      const out = [];
      for (let i = 0; i < arr.length; i++) {
        const subst = new Map();
        subst.set(params[0].name, valueToNode(arr[i]));
        if (params[1]) subst.set(params[1].name, t.numericLiteral(i));
        if (params[2]) subst.set(params[2].name, t.identifier('undefined'));
        const ev = evaluateLambdaBody(body, subst);
        if (!ev.confident) return null;
        out.push(ev.value);
      }
      return out;
    }

    if (methodName === 'filter') {
      if (params.length < 1 || params.length > 3) return null;
      const out = [];
      for (let i = 0; i < arr.length; i++) {
        const subst = new Map();
        subst.set(params[0].name, valueToNode(arr[i]));
        if (params[1]) subst.set(params[1].name, t.numericLiteral(i));
        const ev = evaluateLambdaBody(body, subst);
        if (!ev.confident || typeof ev.value !== 'boolean') return null;
        if (ev.value) out.push(arr[i]);
      }
      return out;
    }

    if (methodName === 'reduce') {
      if (params.length < 2 || params.length > 4) return null;
      let acc;
      let startIdx;
      if (secondArg !== undefined && secondArg !== null) {
        const initEv = evaluate(secondArg);
        if (!initEv.confident) return null;
        acc = initEv.value;
        startIdx = 0;
      } else {
        if (arr.length === 0) return null;
        acc = arr[0];
        startIdx = 1;
      }
      for (let i = startIdx; i < arr.length; i++) {
        const subst = new Map();
        subst.set(params[0].name, valueToNode(acc));
        subst.set(params[1].name, valueToNode(arr[i]));
        if (params[2]) subst.set(params[2].name, t.numericLiteral(i));
        if (params[3]) subst.set(params[3].name, t.identifier('undefined'));
        const ev = evaluateLambdaBody(body, subst);
        if (!ev.confident) return null;
        acc = ev.value;
      }
      return acc;
    }

    if (methodName === 'forEach') {
      if (params.length < 1 || params.length > 3) return null;
      for (let i = 0; i < arr.length; i++) {
        const subst = new Map();
        subst.set(params[0].name, valueToNode(arr[i]));
        if (params[1]) subst.set(params[1].name, t.numericLiteral(i));
        const ev = evaluateLambdaBody(body, subst);
        if (!ev.confident) return null;
      }
      return undefined; // forEach yields undefined; confident via null-check pattern
    }
  } catch (e) {
    return null;
  }

  return null;
}

/**
 * Get the expression body of a lambda: either the arrow's implicit
 * return expression, or a single-return block.
 */
function getLambdaBody(lambda) {
  if (t.isArrowFunctionExpression(lambda) && !t.isBlockStatement(lambda.body)) {
    return lambda.body;
  }
  if (t.isBlockStatement(lambda.body) && lambda.body.body.length === 1) {
    const stmt = lambda.body.body[0];
    if (t.isReturnStatement(stmt) && stmt.argument) return stmt.argument;
  }
  return null;
}

/**
 * Evaluate a lambda body expression with parameter substitution.
 * Substitution map: param name -> AST node (or null for undefined).
 */
function evaluateLambdaBody(body, subst) {
  const cloned = cloneAndSubstitute(body, subst);
  return evaluate(cloned);
}

/**
 * Deep-clone a node, replacing identifiers per the substitution map.
 */
function cloneAndSubstitute(node, subst) {
  if (!node) return node;
  if (t.isIdentifier(node)) {
    if (subst.has(node.name)) {
      const repl = subst.get(node.name);
      return repl === null ? t.identifier('undefined') : t.cloneNode(repl, true);
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

/**
 * True when the binding's value can be mutated anywhere in the program:
 *  - mutating method calls: name.push/pop/shift/unshift/splice/sort/reverse/fill/copyWithin
 *  - element writes: name[...] = ...  (or compound)
 *  - delete name[...]
 *  - Object.assign(name, ...), or the name passed as a function argument
 *    (callee could mutate — conservative).
 * Cached per binding.
 */
const mutationCache = new WeakMap();

const MUTATING_METHODS = new Set([
  'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse',
  'fill', 'copyWithin', 'set',
]);

function bindingIsMutated(binding) {
  if (!binding) return true;
  if (mutationCache.has(binding)) return mutationCache.get(binding);

  // Params/imports/function names are not foldable array data — treat as
  // mutated (conservative) and bail before touching shape assumptions.
  if (!binding.path || !binding.path.isVariableDeclarator()) return true;
  if (!t.isIdentifier(binding.path.node.id)) return true;

  let mutated = false;
  const name = binding.path.node.id.name;

  try {
    binding.scope.path.traverse({
      MemberExpression(path) {
        if (t.isIdentifier(path.node.object, { name })) {
          const parent = path.parent;

          // name.mutatingMethod(...)
          if (
            path.node === parent.callee &&
            t.isCallExpression(parent) &&
            t.isIdentifier(path.node.property)
          ) {
            if (MUTATING_METHODS.has(path.node.property.name)) {
              mutated = true;
            }
          }

          // name[...] = ... / delete name[...]
          if (
            (t.isAssignmentExpression(parent) && parent.left === path.node) ||
            (t.isUnaryExpression(parent) && parent.operator === 'delete')
          ) {
            mutated = true;
          }
        }
      },
    });
  } catch (e) {
    mutated = true; // analysis failure -> assume mutation
  }

  mutationCache.set(binding, mutated);
  return mutated;
}

/**
 * Return the init node for a name (declarator init or single-assignment
 * rhs) WITHOUT evaluating it — callers control recursion depth.
 */
function resolveConstBindingShallow(name) {
  return resolveConstBinding(name);
}

/**
 * Resolve a const- or never-reassigned-let-bound variable name to its
 * init expression through the ambient scope. Handles the separate
 * declaration-then-single-assignment idiom:
 *
 *   let v1;         (or  let v1, v2 = ...;)
 *   v1 = expr;      <- exactly one assignment, before any read
 *
 * Depth-capped to survive cyclic references.
 */
const resolving = new Set();

function resolveConstBinding(name) {
  if (!currentScope) return null;
  if (resolving.has(name)) return null; // cycle guard
  resolving.add(name);
  try {
    return resolveConstBindingInner(name);
  } finally {
    resolving.delete(name);
  }
}

function resolveConstBindingInner(name) {
  if (!currentScope) return null;
  const binding = currentScope.getBinding(name);
  if (!binding || !binding.path || !binding.path.isVariableDeclarator()) return null;
  const decl = binding.path.parentPath;
  if (!decl || !t.isVariableDeclaration(decl.node)) return null;
  if (decl.node.kind !== 'const' && decl.node.kind !== 'let' && decl.node.kind !== 'var') return null;

  // Direct init.
  if (binding.path.node.init) {
    if (binding.constantViolations.length > 0) return null;
    return binding.path.node.init;
  }

  // Separate assignment: exactly one `name = expr` before all reads.
  if (binding.constantViolations.length === 1) {
    const viol = binding.constantViolations[0];
    const violNode = viol.node || viol;
    if (
      t.isAssignmentExpression(violNode) &&
      violNode.operator === '=' &&
      t.isIdentifier(violNode.left, { name })
    ) {
      const rhs = violNode.right;
      // Position check: every read must come after the assignment.
      // Cloned/substituted nodes may lack position info — when unknown,
      // accept (the single-assignment + no-other-violations invariant
      // already guarantees a single write; read-before-write would be
      // undefined behavior in the original too).
      const assignPos = violNode.start;
      if (typeof assignPos === 'number') {
        const allAfter = binding.referencePaths.every((r) => typeof r.node.start !== 'number' || r.node.start >= assignPos);
        if (!allAfter) return null;
      }
      return rhs;
    }
  }

  return null;
}

/**
 * Run a callback with the ambient scope set, so identifier resolution
 * works during evaluation. Returns the callback's result.
 */
function withScope(scope, fn) {
  const prev = currentScope;
  currentScope = scope;
  try {
    return fn();
  } finally {
    currentScope = prev;
  }
}

/**
 * Convert a concrete JS value into a Babel AST node.
 */
function valueToNode(value) {
  if (value === undefined) return t.identifier('undefined');
  if (value === null) return t.nullLiteral();
  if (typeof value === 'string') return t.stringLiteral(value);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return t.binaryExpression('/', t.numericLiteral(0), t.numericLiteral(0));
    if (value === Infinity) return t.binaryExpression('/', t.numericLiteral(1), t.numericLiteral(0));
    if (value === -Infinity) return t.binaryExpression('/', t.numericLiteral(-1), t.numericLiteral(0));
    return t.numericLiteral(value);
  }
  if (typeof value === 'boolean') return t.booleanLiteral(value);
  if (typeof value === 'bigint') return t.bigIntLiteral(value.toString());
  if (Array.isArray(value)) {
    return t.arrayExpression(value.map((v) => valueToNode(v)));
  }
  if (typeof value === 'object') {
    return t.objectExpression(
      Object.entries(value).map(([k, v]) =>
        t.objectProperty(t.stringLiteral(k), valueToNode(v))
      )
    );
  }
  return t.identifier('undefined');
}

module.exports = { evaluate, valueToNode, withScope, cloneAndSubstitute };
