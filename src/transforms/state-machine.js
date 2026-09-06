'use strict';

const t = require('@babel/types');
const { evaluate, withScope } = require('../evaluator');

/**
 * Pass: State-machine linearization.
 *
 * Reconstructs the sequential flow from the dispatcher pattern:
 *
 *   let state = 0x13;
 *   const states = { 0x13() { ...; state = 0x29; }, ... };
 *   while (state !== 0x77) {
 *     const fn = states[state];
 *     if (typeof fn !== 'function') { state = 0x77; break; }
 *     fn();
 *   }
 *
 * A handler is eligible when every path through its body either:
 *   - assigns the state var to a constant, or
 *   - terminates the machine (assigns END / breaks / returns).
 * Optional side-effect statements (calls, etc.) are preserved in order.
 *
 * The pass simulates the chain from the initial state, emits the handlers'
 * side effects in execution order, and removes the table + loop + var.
 */
function linearizeStateMachine(ast) {
  const { traverse } = require('../utils');

  let changed = true;
  let iterations = 0;

  while (changed && iterations < 5) {
    changed = false;
    iterations++;

    traverse(ast, {
      WhileStatement(path) {
        if (tryLinearize(path)) {
          changed = true;
        }
      },
    });
  }

  return ast;
}

function tryLinearize(path) {
  const node = path.node;

  // while (state !== END)
  if (!t.isBinaryExpression(node.test, { operator: '!==' }) && !t.isBinaryExpression(node.test, { operator: '!=' })) return false;
  const stateRef = node.test.left;
  const endValue = withScope(path.scope, () => evaluate(node.test.right));
  if (!t.isIdentifier(stateRef)) return false;
  if (!endValue.confident) return false;

  // Find the states table: const states = { ... } referenced in the loop.
  const binding = path.scope.getBinding(stateRef.name);
  if (!binding) return false;

  // The loop body must reference a table: fn = table[state]; fn();
  const body = node.body;
  if (!t.isBlockStatement(body)) return false;

  // Locate: const fn = states[state]
  let table = null;
  let tableName = null;
  for (const stmt of body.body) {
    if (t.isVariableDeclaration(stmt)) {
      for (const d of stmt.declarations) {
        if (
          d.init &&
          t.isMemberExpression(d.init) &&
          t.isIdentifier(d.init.object) &&
          t.isIdentifier(d.init.property, { name: stateRef.name })
        ) {
          table = path.scope.getBinding(d.init.object.name);
          tableName = d.init.object.name;
        }
      }
    }
  }
  if (!table || !table.path || !table.path.isVariableDeclarator()) return false;

  const tableInit = table.path.node.init;
  if (!t.isObjectExpression(tableInit)) return false;

  // Map numeric keys -> handler functions.
  const handlers = new Map();
  for (const prop of tableInit.properties) {
    if (!t.isObjectMethod(prop) && !isFunctionProp(prop)) return false;
    const keyEv = evaluate(prop.key);
    if (!keyEv.confident || typeof keyEv.value !== 'number') return false;
    handlers.set(keyEv.value, prop);
  }
  if (handlers.size === 0) return false;

  // Find the initial state: let state = <constant> declared before the loop.
  const decl = binding.path;
  if (!decl.isVariableDeclarator() || !decl.node.init) return false;
  const initEv = withScope(path.scope, () => evaluate(decl.node.init));
  if (!initEv.confident || typeof initEv.value !== 'number') return false;

  // Simulate the chain.
  const out = [];
  let state = initEv.value;
  let guard = 0;
  const visited = new Set();

  while (state !== endValue.value) {
    if (guard++ > 64) return false;
    if (visited.has(state)) return false; // cycle — bail
    visited.add(state);

    const handler = handlers.get(state);
    if (!handler) break; // typeof check path: state = END, break — machine ends

    const sim = simulateHandler(handler.body, stateRef.name, endValue.value, path.scope);
    if (!sim) return false;

    out.push(...sim.effects);

    if (sim.terminal) break;
    state = sim.next;
  }

  if (out.length === 0) return false;

  // Emit the linearized statements in place of the while loop.
  path.replaceWithMultiple(out.map((s) => t.cloneNode(s, true)));

  // Remove the table declaration and the state var if now unused.
  if (countRefs(path, tableName) === 0) {
    const tdecl = table.path.parentPath;
    if (t.isVariableDeclaration(tdecl.node) && tdecl.node.declarations.length === 1) tdecl.remove();
    else table.path.remove();
  }
  if (countRefs(path, stateRef.name) === 0) {
    const sdecl = decl.parentPath;
    if (t.isVariableDeclaration(sdecl.node) && sdecl.node.declarations.length === 1) sdecl.remove();
    else decl.remove();
  }

  return true;
}

function isFunctionProp(prop) {
  return t.isObjectProperty(prop) && (t.isFunctionExpression(prop.value) || t.isArrowFunctionExpression(prop.value));
}

/**
 * Simulate a handler body. Returns { effects: [statements], next: number, terminal: bool }
 * or null when the handler shape is unsupported.
 */
function simulateHandler(body, stateName, endValue, scope) {
  if (!t.isBlockStatement(body)) return null;

  const effects = [];
  let next = null;
  let terminal = false;

  for (const stmt of body.body) {
    // Direct state assignment: state = K; or state = K, return;
    if (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression)) {
      const a = stmt.expression;
      if (t.isIdentifier(a.left, { name: stateName })) {
        const vEv = withScope(scope, () => evaluate(a.right));
        if (vEv.confident && typeof vEv.value === 'number') {
          if (next !== null) return null; // multiple assignments — bail
          next = vEv.value;
          continue;
        }
      }
      // Other assignments are side effects we can't reorder safely.
      effects.push(stmt);
      continue;
    }

    // Side-effect calls and everything else get preserved in order.
    // But conditional state assignments inside if/else must resolve statically.
    if (t.isIfStatement(stmt)) {
      const sim = simulateIf(stmt, stateName, endValue, scope);
      if (!sim) return null;
      effects.push(...sim.effects);
      if (sim.terminal) { terminal = true; }
      if (sim.next !== null) {
        if (next !== null) return null;
        next = sim.next;
      }
      continue;
    }

    // return with no value inside a handler = end of handler.
    if (t.isReturnStatement(stmt)) {
      terminal = true;
      continue;
    }

    // Anything else: preserve (side effects like console.log calls).
    effects.push(stmt);
  }

  if (next === null && !terminal) return null;

  return { effects, next, terminal };
}

/**
 * Statically resolve an if-statement whose branches assign the state var.
 * Returns the same shape as simulateHandler, or null when unresolvable.
 */
function simulateIf(stmt, stateName, endValue, scope) {
  const testEv = withScope(scope, () => evaluate(stmt.test));
  if (!testEv.confident) return null;

  const branch = testEv.value ? stmt.consequent : stmt.alternate;
  if (!branch) {
    // No else taken — nothing happens; state unchanged is not allowed
    // (would loop forever), so handlers always assign somewhere.
    return { effects: [], next: null, terminal: false };
  }

  if (t.isBlockStatement(branch)) {
    return simulateHandler(branch, stateName, endValue, scope);
  }
  return simulateHandler(t.blockStatement([branch]), stateName, endValue, scope);
}

function countRefs(path, name) {
  let count = 0;
  path.scope.path.traverse({
    Identifier(idPath) {
      if (idPath.node.name === name && idPath.isReferencedIdentifier()) count++;
    },
  });
  return count;
}

module.exports = linearizeStateMachine;