'use strict';

const t = require('@babel/types');
const { evaluate, valueToNode, withScope } = require('../evaluator');

/**
 * Pass: Constant loop interpretation.
 *
 * Fully evaluates bounded, side-effect-free for-loops whose only effects
 * are assignments to local variables and pushes onto a tracked array:
 *
 *   const out = [];
 *   for (let i = 0; i < s.length; i++) {
 *     const q = expr(i);           // constant-foldable per iteration
 *     if (guard(q)) throw ...;      // must statically never fire
 *     out.push(q);
 *   }
 *   out.reverse();
 *   String.fromCharCode(...out)    // -> the materialized literal
 *
 * Safety rules:
 *  - the loop variable must be numeric with constant bounds
 *  - every statement in the body must be: var decl, assignment, if-throw,
 *    or a push onto the tracked array
 *  - any guard must evaluate to false on every iteration
 *  - iteration cap of 4096
 */
function interpretLoops(ast) {
  const { traverse } = require('../utils');

  let changed = true;
  let iterations = 0;

  while (changed && iterations < 8) {
    changed = false;
    iterations++;

    traverse(ast, {
      // Refresh scope caches: earlier passes mutated the AST and Babel's
      // binding info may be stale (wrong names, wrong violation counts).
      Program(programPath) {
        try {
          programPath.scope.crawl();
        } catch (e) {
          // ignore crawl failures on damaged scopes
        }
      },
      ForStatement(path) {
        // Refresh this scope's cache: earlier passes mutated nodes in
        // place and Babel's binding/violation data may point at stale
        // (detached) nodes.
        try {
          path.scope.crawl();
        } catch (e) {
          // ignore crawl failures on damaged scopes
        }
        if (tryInterpret(path, ast)) {
          changed = true;
        }
      },
    });
  }

  return ast;
}

const MAX_ITERATIONS = 4096;

function tryInterpret(path, ast) {
  const node = path.node;

  // ---- Pattern-match the surrounding statements ----
  // We need: (optional) decl of the array before the loop, the loop itself,
  // and consumers after it. Work on the statement list containing the loop.
  const bodyPath = path.parentPath;
  if (!bodyPath.isBlockStatement() && !bodyPath.isProgram()) return false;
  const stmts = bodyPath.node.body;
  const loopIdx = stmts.indexOf(node);
  if (loopIdx < 0) return false;

  // ---- Loop shape ----
  // for (let i = <const>; i < <const or id.length>; i++)
  if (!node.init || !t.isVariableDeclaration(node.init)) return false;
  const decl0 = node.init.declarations[0];
  if (!decl0 || !t.isIdentifier(decl0.id)) return false;
  const loopVar = decl0.id.name;

  if (!node.test || !t.isBinaryExpression(node.test, { operator: '<' })) return false;
  if (!t.isIdentifier(node.test.left, { name: loopVar })) return false;
  if (node.update && !isSimpleUpdate(node.update, loopVar)) return false;

  // ---- Find the pushed array ----
  // Must be declared (as []) right before the loop or earlier in the block.
  const body = node.body;
  if (!t.isBlockStatement(body)) return false;

  let arrayName = null;
  for (const stmt of body.body) {
    if (t.isExpressionStatement(stmt) && t.isCallExpression(stmt.expression)) {
      const callee = stmt.expression.callee;
      if (t.isMemberExpression(callee) && t.isIdentifier(callee.object)) {
        let isPush = false;
        if (!callee.computed && t.isIdentifier(callee.property, { name: 'push' })) isPush = true;
        else if (callee.computed && t.isStringLiteral(callee.property, { value: 'push' })) isPush = true;
        if (isPush) {
          arrayName = callee.object.name;
          break;
        }
      }
    }
  }
  if (!arrayName) return false;

  // The array must be declared as [] in the same block, before the loop.
  let arrayDecl = null;
  for (let i = 0; i < loopIdx; i++) {
    const s = stmts[i];
    if (!t.isVariableDeclaration(s)) continue;
    for (const d of s.declarations) {
      if (t.isIdentifier(d.id, { name: arrayName }) && d.init && t.isArrayExpression(d.init) && d.init.elements.length === 0) {
        arrayDecl = d;
      }
    }
  }
  if (!arrayDecl) return false;

  // Every other reference to the array outside the loop must come after it.
  // (We rewrite those references with the materialized literal.)

  // ---- Interpret ----
  const startEv = withScope(path.scope, () => evaluate(decl0.init));
  if (!startEv.confident || typeof startEv.value !== 'number') return false;

  // The loop bound: constant or <id>.length where id is a const string.
  let bound = null;
  const testRight = node.test.right;
  const boundEv = withScope(path.scope, () => evaluate(testRight));
  if (boundEv.confident && typeof boundEv.value === 'number') {
    bound = boundEv.value;
  }
  if (bound === null) return false;

  if (bound - startEv.value > MAX_ITERATIONS) return false;

  // Simulate.
  const values = [];
  let env = new Map();

  for (let i = startEv.value; i < bound; i++) {
    const iterEnv = new Map(env);
    iterEnv.set(loopVar, i);

    for (const stmt of body.body) {
      const ok = execStatement(stmt, iterEnv, arrayName, values, path.scope, i);
      if (!ok) return false;
    }

    env = iterEnv;
  }

  // ---- Verify the array has no other uses inside the loop block ----
  // (pushes already handled; reads would need merging — bail on them)
  for (const stmt of body.body) {
    if (referencesArrayBeyondPush(stmt, arrayName)) return false;
  }

  // ---- Consume a directly-following `arr.reverse()` statement ----
  // The obfuscator pattern ends with in-place reversal before printing.
  // Fold it into the materialized values so the output is final.
  let consumedReverse = false;
  const after = stmts[loopIdx + 1];
  if (
    after &&
    t.isExpressionStatement(after) &&
    t.isCallExpression(after.expression) &&
    t.isMemberExpression(after.expression.callee) &&
    t.isIdentifier(after.expression.callee.object, { name: arrayName }) &&
    after.expression.arguments.length === 0
  ) {
    let isReverse = false;
    const prop = after.expression.callee.property;
    if (!after.expression.callee.computed && t.isIdentifier(prop, { name: 'reverse' })) isReverse = true;
    else if (after.expression.callee.computed && t.isStringLiteral(prop, { value: 'reverse' })) isReverse = true;

    if (isReverse) {
      values.reverse();
      consumedReverse = true;
    }
  }

  // ---- Rewrite ----
  // Replace the loop with nothing; replace subsequent uses of the array
  // with the materialized values; remove the array declaration.
  // The array's post-loop consumers (reverse(), spread) get folded by
  // constant-folding once they see a literal array.

  arrayDecl.init = valueToNode(values);

  // Remove the consumed reverse() statement BEFORE removing the loop —
  // child path indices shift on removal.
  if (consumedReverse) {
    const afterPath = bodyPath.get('body')[loopIdx + 1];
    if (afterPath) afterPath.remove();
  }

  path.remove();

  return true;
}

function isSimpleUpdate(node, loopVar) {
  return (
    (t.isUpdateExpression(node) && t.isIdentifier(node.argument, { name: loopVar })) ||
    (t.isAssignmentExpression(node) &&
      t.isIdentifier(node.left, { name: loopVar }) &&
      node.operator === '+=' &&
      t.isNumericLiteral(node.right, { value: 1 }))
  );
}

/**
 * Execute one body statement in the interpreter env.
 * Returns false when the statement is unsupported.
 */
function execStatement(stmt, env, arrayName, values, scope, i) {
  // const/let decl with evaluable init.
  if (t.isVariableDeclaration(stmt)) {
    for (const d of stmt.declarations) {
      if (!t.isIdentifier(d.id) || !d.init) return false;
      const ev = evalWithEnv(d.init, env, scope);
      if (!ev.confident) return false;
      env.set(d.id.name, ev.value);
    }
    return true;
  }

  // Assignment to a local: x = expr  (or compound op)
  if (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression)) {
    const a = stmt.expression;
    if (!t.isIdentifier(a.left)) return false;

    let rhs;
    if (a.operator === '=') {
      const ev = evalWithEnv(a.right, env, scope);
      if (!ev.confident) return false;
      rhs = ev.value;
    } else {
      // Compound: x op= expr  ->  x = x op expr
      const cur = env.get(a.left.name);
      if (typeof cur !== 'number') return false;
      const ev = evalWithEnv(a.right, env, scope);
      if (!ev.confident || typeof ev.value !== 'number') return false;
      switch (a.operator) {
        case '+=': rhs = cur + ev.value; break;
        case '-=': rhs = cur - ev.value; break;
        case '*=': rhs = cur * ev.value; break;
        case '^=': rhs = cur ^ ev.value; break;
        case '%=': rhs = cur % ev.value; break;
        default: return false;
      }
    }
    env.set(a.left.name, rhs);
    return true;
  }

  // Tracked array push (obj.push(x) or obj['push'](x)).
  if (t.isExpressionStatement(stmt) && t.isCallExpression(stmt.expression)) {
    const callee = stmt.expression.callee;
    if (t.isMemberExpression(callee) && t.isIdentifier(callee.object, { name: arrayName })) {
      let isPush = false;
      if (!callee.computed && t.isIdentifier(callee.property, { name: 'push' })) isPush = true;
      else if (callee.computed && t.isStringLiteral(callee.property, { value: 'push' })) isPush = true;

      if (isPush) {
        const args = stmt.expression.arguments;
        if (args.length !== 1) return false;
        const ev = evalWithEnv(args[0], env, scope);
        if (!ev.confident) return false;
        values.push(ev.value);
        return true;
      }
    }
  }

  // Guard: if (<const-cond>) throw/anything — must be false.
  if (t.isIfStatement(stmt)) {
    const testEv = evalWithEnv(stmt.test, env, scope);
    if (!testEv.confident) return false;
    if (testEv.value) return false; // guard would fire — bail (semantics!)
    // Guard never fires: consequent is dead; alternate must also be safe.
    if (stmt.alternate) {
      if (t.isBlockStatement(stmt.alternate)) {
        for (const s of stmt.alternate.body) {
          if (!execStatement(s, env, arrayName, values, scope, i)) return false;
        }
        return true;
      }
      return execStatement(stmt.alternate, env, arrayName, values, scope, i);
    }
    return true;
  }

  // Empty statement.
  if (t.isEmptyStatement(stmt)) return true;

  return false;
}

/**
 * Evaluate an expression where env names shadow the ambient scope.
 */
function evalWithEnv(node, env, scope) {
  // Build a substitution for env-known identifiers, then evaluate.
  const substituted = substituteEnv(node, env);
  return withScope(scope, () => evaluate(substituted));
}

/**
 * Clone a node, replacing identifiers present in env with literal nodes.
 */
function substituteEnv(node, env) {
  const { cloneAndSubstitute } = require('../evaluator');
  const subst = new Map();
  for (const [k, v] of env) {
    subst.set(k, valueToNode(v));
  }
  return cloneAndSubstitute(node, subst);
}

/**
 * True when the statement references the tracked array in any way other
 * than a direct `arr.push(x)` expression statement.
 */
function referencesArrayBeyondPush(stmt, arrayName) {
  if (t.isExpressionStatement(stmt) && t.isCallExpression(stmt.expression)) {
    const callee = stmt.expression.callee;
    if (
      t.isMemberExpression(callee) &&
      t.isIdentifier(callee.object, { name: arrayName })
    ) {
      let isPush = false;
      if (!callee.computed && t.isIdentifier(callee.property, { name: 'push' })) isPush = true;
      else if (callee.computed && t.isStringLiteral(callee.property, { value: 'push' })) isPush = true;

      if (isPush) {
        // push is fine — but args must not reference the array
        const src = safeCode(stmt.expression.arguments);
        return src.includes(arrayName);
      }
    }
  }
  const src = safeCode(stmt);
  return src.includes(arrayName);
}

function safeCode(node) {
  try {
    const generate = require('@babel/generator').default;
    return generate(t.cloneNode(node, true)).code;
  } catch (e) {
    return '';
  }
}

module.exports = interpretLoops;