'use strict';

const t = require('@babel/types');
const { evaluate, valueToNode, withScope } = require('../evaluator');

/**
 * Pass: VM bytecode interpretation.
 *
 * Defeats the highest tier of JS obfuscation — the custom virtual
 * machine. Recognizes the canonical shape:
 *
 *   const bytecode = [0x1, 0x2, ...];        // constant program
 *   const stack = [];
 *   let pc = 0;
 *   while (true) {
 *     switch (bytecode[pc++]) {
 *       case 0: stack.push(table[bytecode[pc++]]); continue;
 *       case 1: stack.push(stack.pop() + stack.pop()); continue;
 *       ...
 *       case N: <sink>; break;               // e.g. console.log(stack.pop())
 *       default: <exit path>
 *     }
 *     break;
 *   }
 *
 * Requirements for safe interpretation:
 *  - the bytecode array is constant and provably unmutated
 *  - the switch discriminant is bytecode[pc++] (post-increment member)
 *  - each case handler is one of the recognized micro-ops:
 *      push-literal, push-from-table, pop-into-var, binary op on stack,
 *      member call (sink), unconditional pc set (jump)
 *  - execution is bounded (64k steps)
 *
 * The VM is symbolically executed with concrete values; the emitted
 * program is the reconstructed straight-line JavaScript.
 */
function interpretVM(ast) {
  const { traverse } = require('../utils');

  let changed = true;
  let iterations = 0;

  while (changed && iterations < 4) {
    changed = false;
    iterations++;

    traverse(ast, {
      WhileStatement(path) {
        if (tryInterpretVM(path)) {
          changed = true;
        }
      },
    });
  }

  return ast;
}

const MAX_STEPS = 65536;

function tryInterpretVM(path) {
  const node = path.node;

  // while (true)
  if (!t.isBooleanLiteral(node.test, { value: true })) return false;
  if (!t.isBlockStatement(node.body)) return false;

  // switch (bytecode[pc++])
  const switchStmt = node.body.body.find((s) => t.isSwitchStatement(s));
  if (!switchStmt) return false;
  const disc = switchStmt.discriminant;
  if (!t.isMemberExpression(disc) || !disc.computed) return false;
  if (!t.isIdentifier(disc.object)) return false;
  const bcName = disc.object.name;
  const pcExpr = disc.property;
  if (!t.isUpdateExpression(pcExpr) || pcExpr.operator !== '++' || pcExpr.prefix) return false;
  if (!t.isIdentifier(pcExpr.argument)) return false;
  const pcName = pcExpr.argument.name;

  // Bytecode array: const bytecode = [ ...constants ] in scope, unmutated.
  const bcBinding = path.scope.getBinding(bcName);
  if (!bcBinding || !bcBinding.path.isVariableDeclarator()) return false;
  const bcInit = bcBinding.path.node.init;
  if (!bcInit || !t.isArrayExpression(bcInit)) return false;
  const bcEv = withScope(path.scope, () => evaluate(bcInit));
  if (!bcEv.confident || !Array.isArray(bcEv.value)) return false;
  if (!bcEv.value.every((v) => typeof v === 'number')) return false;
  const bytecode = bcEv.value;

  // pc init: let pc = 0 (constant).
  const pcBinding = path.scope.getBinding(pcName);
  if (!pcBinding || !pcBinding.path.isVariableDeclarator()) return false;
  const pcInitEv = withScope(path.scope, () => evaluate(pcBinding.path.node.init));
  if (!pcInitEv.confident || typeof pcInitEv.value !== 'number') return false;

  // Collect case handlers: numeric test -> statements.
  // A default clause is allowed when inert (break/continue only) — it is
  // the machine's exit path in the common shape.
  const handlers = new Map();
  let defaultIsInert = true;
  for (const c of switchStmt.cases) {
    if (!c.test) {
      for (const s of c.consequent) {
        if (!t.isBreakStatement(s) && !t.isContinueStatement(s) && !t.isEmptyStatement(s)) {
          defaultIsInert = false;
        }
      }
      continue;
    }
    const testEv = evaluate(c.test);
    if (!testEv.confident || typeof testEv.value !== 'number') return false;
    handlers.set(testEv.value, c.consequent);
  }
  if (handlers.size === 0) return false;
  if (!defaultIsInert) return false;

  // ---- Symbolic execution ----
  // Machine state:
  let pc = pcInitEv.value;
  const stack = [];
  // name -> concrete value (registers); unknown = null
  const regs = new Map();
  const emitted = []; // reconstructed statements

  let steps = 0;
  let exitReason = null; // 'fallthrough' | 'break' | 'jump-out'

  while (steps < MAX_STEPS) {
    steps++;
    if (pc < 0 || pc >= bytecode.length) { exitReason = 'jump-out'; break; }
    const op = bytecode[pc];
    pc++;

    const handler = handlers.get(op);
    if (!handler) { exitReason = 'fallthrough'; break; }

    const sim = execHandler(handler, { pc, stack, regs, bcName, bytecode, path });
    if (!sim) return false; // unrecognized op — bail out entirely

    ({ pc } = sim);

    if (sim.emit !== undefined && sim.emit !== null) {
      emitted.push(sim.emit);
    }
    if (sim.exit) {
      exitReason = sim.exit;
      break;
    }
  }

  if (steps >= MAX_STEPS) return false;
  if (emitted.length === 0) return false;

  // Only rewrite when the machine terminated cleanly.
  if (exitReason !== 'break' && exitReason !== 'fallthrough' && exitReason !== 'jump-out') {
    return false;
  }

  // ---- Rewrite ----
  path.replaceWithMultiple(emitted.map((s) => t.cloneNode(s, true)));
  return true;
}

/**
 * Execute one case handler. Returns { pc, emit?, exit? } or null when
 * the handler shape is unrecognized.
 */
function execHandler(handler, machine) {
  let pc = machine.pc;
  let emit = null;
  let exit = null;

  const stmts = handler.filter((s) => !t.isContinueStatement(s) && !t.isEmptyStatement(s));

  for (const stmt of stmts) {
    // break; — terminates the loop (classic exit op)
    if (t.isBreakStatement(stmt)) {
      exit = 'break';
      continue;
    }

    // return; — also terminates
    if (t.isReturnStatement(stmt)) {
      exit = 'break';
      continue;
    }

    // stack.push(x);
    if (t.isExpressionStatement(stmt) && isPush(stmt.expression, 'stack')) {
      const arg = stmt.expression.arguments[0];

      // push from bytecode: bytecode[pc++]
      if (isBcRead(arg, machine)) {
        const val = machine.bytecode[pc];
        pc++;
        machine.stack.push(val);
        continue;
      }

      // push literal / constant
      const ev = withScope(machine.path.scope, () => evaluate(arg));
      if (ev.confident && (typeof ev.value === 'string' || typeof ev.value === 'number' || typeof ev.value === 'boolean')) {
        machine.stack.push(ev.value);
        continue;
      }

      // push binary op over stack pops / registers (the concat/arith op):
      //   stack.push(stack.pop() + stack.pop())
      const binVal = simBinary(arg, machine);
      if (binVal !== null && binVal !== undefined) {
        machine.stack.push(binVal);
        continue;
      }

      // push table[bytecode[pc++]] — constant string table
      if (t.isMemberExpression(arg) && arg.computed && isBcRead(arg.property, machine)) {
        const idx = machine.bytecode[pc];
        pc++;
        const tableEv = withScope(machine.path.scope, () => evaluate(arg.object));
        if (tableEv.confident && Array.isArray(tableEv.value)) {
          const v = tableEv.value[idx];
          if (typeof v === 'string' || typeof v === 'number') {
            machine.stack.push(v);
            continue;
          }
        }
        return null;
      }

      return null;
    }

    // stack.pop() as a full statement (discard)
    if (
      t.isExpressionStatement(stmt) &&
      t.isCallExpression(stmt.expression) &&
      t.isMemberExpression(stmt.expression.callee) &&
      t.isIdentifier(stmt.expression.callee.object, { name: 'stack' }) &&
      t.isIdentifier(stmt.expression.callee.property, { name: 'pop' })
    ) {
      machine.stack.pop();
      continue;
    }

    // Assignment with pops/ops on the stack.
    if (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression)) {
      const a = stmt.expression;

      // var = stack.pop()
      if (
        a.operator === '=' &&
        t.isIdentifier(a.left) &&
        t.isCallExpression(a.right) &&
        t.isMemberExpression(a.right.callee) &&
        t.isIdentifier(a.right.callee.object, { name: 'stack' }) &&
        t.isIdentifier(a.right.callee.property, { name: 'pop' })
      ) {
        const v = machine.stack.pop();
        machine.regs.set(a.left.name, v === undefined ? null : v);
        continue;
      }

      // var = var OP stack.pop() | stack.pop() OP var | binary of pops
      const binEv = simBinary(a.right, machine);
      if (binEv !== null && a.operator === '=' && t.isIdentifier(a.left)) {
        machine.regs.set(a.left.name, binEv);
        continue;
      }

      // var += stack.pop() — accumulator
      if (a.operator === '+=' && t.isIdentifier(a.left)) {
        const operand = evalOperand(a.right, machine);
        if (operand !== null && operand !== undefined) {
          const cur = machine.regs.get(a.left.name);
          const next = (typeof cur === 'string' || typeof cur === 'number') && operand !== null
            ? cur + operand
            : null;
          machine.regs.set(a.left.name, next);
          continue;
        }
        return null;
      }

      return null;
    }

    // SINK: an expression statement calling something on popped/constant args
    // (console.log etc.) — emit the reconstructed call.
    if (t.isExpressionStatement(stmt) && t.isCallExpression(stmt.expression)) {
      const call = stmt.expression;
      const callee = call.callee;

      // Recognized sink: any member call whose args are all resolvable
      // from machine state (pops, registers, literals).
      if (t.isMemberExpression(callee)) {
        const newArgs = [];
        for (const arg of call.arguments) {
          if (isPopCall(arg)) {
            newArgs.push(machine.stack.pop());
          } else {
            const ev = evalOperand(arg, machine);
            if (ev === null || ev === undefined) return null;
            newArgs.push(ev);
          }
        }

        // Resolve the callee object/property statically if possible.
        const objEv = withScope(machine.path.scope, () => evaluate(callee.object));
        const propName = !callee.computed && t.isIdentifier(callee.property) ? callee.property.name : null;

        if (objEv.confident && typeof objEv.value === 'object' && propName === 'log') {
          // console.log(...) — emit with materialized args.
          const argsNodes = newArgs.map((v) =>
            v === null ? t.identifier('undefined') : valueToNode(v)
          );
          emit = t.expressionStatement(
            t.callExpression(
              t.memberExpression(t.identifier('console'), t.identifier('log')),
              argsNodes
            )
          );
          continue;
        }

        // Unknown sink: reconstruct with literal args if all concrete.
        if (newArgs.every((v) => v !== null && v !== undefined)) {
          const argsNodes = newArgs.map((v) => valueToNode(v));
          emit = t.expressionStatement(
            t.callExpression(t.cloneNode(callee, true), argsNodes)
          );
          continue;
        }

        return null;
      }

      return null;
    }

    return null;
  }

  return { pc, emit, exit };
}

/**
 * True for the `bytecode[pc++]` idiom.
 */
function isBcRead(node, machine) {
  return (
    t.isMemberExpression(node) &&
    node.computed &&
    t.isIdentifier(node.object, { name: machine.bcName }) &&
    t.isUpdateExpression(node.property) &&
    node.property.operator === '++' &&
    !node.property.prefix &&
    t.isIdentifier(node.property.argument)
  );
}

/**
 * True for `stack.push(x)` with exactly one argument.
 */
function isPush(node, stackName) {
  return (
    t.isCallExpression(node) &&
    t.isMemberExpression(node.callee) &&
    t.isIdentifier(node.callee.object, { name: stackName }) &&
    t.isIdentifier(node.callee.property, { name: 'push' }) &&
    node.arguments.length === 1
  );
}

function isPopCall(node) {
  return (
    t.isCallExpression(node) &&
    t.isMemberExpression(node.callee) &&
    t.isIdentifier(node.callee.object, { name: 'stack' }) &&
    t.isIdentifier(node.callee.property, { name: 'pop' })
  );
}

/**
 * Evaluate a binary expression over stack pops / registers / constants.
 * Returns the concrete value, or null when unresolvable.
 */
function simBinary(node, machine) {
  if (!t.isBinaryExpression(node)) {
    const v = evalOperand(node, machine);
    return v === undefined ? null : v;
  }

  const l = evalOperand(node.left, machine);
  const r = evalOperand(node.right, machine);
  if (l === null || l === undefined || r === null || r === undefined) return null;

  try {
    switch (node.operator) {
      case '+': return l + r;
      case '-': return l - r;
      case '*': return l * r;
      case '/': return l / r;
      case '%': return l % r;
      case '^': return l ^ r;
      case '&': return l & r;
      case '|': return l | r;
      case '<<': return l << r;
      case '>>': return l >> r;
      case '>>>': return l >>> r;
      default: return null;
    }
  } catch (e) {
    return null;
  }
}

/**
 * Evaluate an operand: stack.pop(), register, or constant.
 * Returns null for unknowns, undefined for empty pop.
 */
function evalOperand(node, machine) {
  if (isPopCall(node)) {
    return machine.stack.pop();
  }
  if (t.isIdentifier(node) && machine.regs.has(node.name)) {
    return machine.regs.get(node.name);
  }
  const ev = withScope(machine.path.scope, () => evaluate(node));
  if (ev.confident && (typeof ev.value === 'string' || typeof ev.value === 'number' || typeof ev.value === 'boolean')) {
    return ev.value;
  }
  return null;
}

module.exports = interpretVM;