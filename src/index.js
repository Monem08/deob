'use strict';

const { parse, generateCode } = require('./utils');
const constantFolding = require('./transforms/constant-folding');
const decodeStringArray = require('./transforms/string-array');
const deadCodeElimination = require('./transforms/dead-code');
const inlineProxies = require('./transforms/proxy-inline');
const inlineProxyFacade = require('./transforms/proxy-facade');
const unflattenControlFlow = require('./transforms/control-flow');
const cleanup = require('./transforms/cleanup');
const fixMojibake = require('./transforms/mojibake');
const deadStoreElimination = require('./transforms/dead-store');
const inlineIIFE = require('./transforms/inline-iife');
const inlineLiterals = require('./transforms/inline-literals');
const renameIdentifiers = require('./transforms/rename');
const aliasFold = require('./transforms/alias-fold');
const identityResolve = require('./transforms/identity');
const constantPropagation = require('./transforms/const-propagate');
const linearizeStateMachine = require('./transforms/state-machine');
const interpretLoops = require('./transforms/loop-interp');
const interpretVM = require('./transforms/vm-interp');
const unpackPacker = require('./transforms/packer');

/**
 * Run the full deobfuscation pipeline on JavaScript source.
 * Returns the deobfuscated source string.
 */
function deobfuscate(code, options = {}) {
  let ast = parse(code);

  const passes = [
    { name: 'string-array', fn: decodeStringArray, enabled: options.stringArray !== false },
    { name: 'packer', fn: unpackPacker, enabled: options.packer !== false },
    { name: 'control-flow', fn: unflattenControlFlow, enabled: options.controlFlow !== false },
    { name: 'proxy-inline', fn: inlineProxies, enabled: options.proxyInline !== false },
    { name: 'proxy-facade', fn: inlineProxyFacade, enabled: options.proxyFacade !== false },
    { name: 'alias-fold', fn: aliasFold, enabled: options.aliasFold !== false },
    { name: 'constant-folding', fn: constantFolding, enabled: options.constantFolding !== false },
    { name: 'identity', fn: identityResolve, enabled: options.identity !== false },
    { name: 'const-propagate', fn: constantPropagation, enabled: options.constPropagate !== false },
    { name: 'loop-interp', fn: interpretLoops, enabled: options.loopInterp !== false },
    { name: 'vm-interp', fn: interpretVM, enabled: options.vmInterp !== false },
    { name: 'state-machine', fn: linearizeStateMachine, enabled: options.stateMachine !== false },
    { name: 'dead-code', fn: deadCodeElimination, enabled: options.deadCode !== false },
    { name: 'mojibake', fn: fixMojibake, enabled: options.mojibake !== false },
    { name: 'inline-iife', fn: inlineIIFE, enabled: options.inlineIife !== false },
    { name: 'inline-literals', fn: inlineLiterals, enabled: options.inlineLiterals !== false },
    { name: 'dead-store', fn: deadStoreElimination, enabled: options.deadStore !== false },
    { name: 'cleanup', fn: cleanup, enabled: options.cleanup !== false },
  ];

  // Multi-round pipeline: earlier passes unlock later ones.
  // The AST is re-parsed between rounds so every pass starts from a clean
  // scope cache — in-place mutation across passes leaves Babel's binding
  // and violation data stale, which breaks alias/constant resolution.
  const rounds = options.rounds || 3;
  for (let i = 0; i < rounds; i++) {
    if (i > 0) {
      try {
        ast = parse(generateCode(ast));
      } catch (e) {
        if (options.verbose) {
          console.error(`[warn] re-parse between rounds failed: ${e.message}`);
        }
        // fall back to continuing on the live AST
      }
    }
    for (const pass of passes) {
      if (!pass.enabled) continue;
      try {
        ast = pass.fn(ast);
      } catch (e) {
        if (options.verbose) {
          console.error(`[warn] pass "${pass.name}" failed: ${e.message}`);
        }
      }
    }
  }

  // Renaming runs last, once the code is stable, for near-original output.
  if (options.rename !== false) {
    try {
      ast = renameIdentifiers(ast);
    } catch (e) {
      if (options.verbose) {
        console.error(`[warn] pass "rename" failed: ${e.message}`);
      }
    }
  }

  return generateCode(ast);
}

module.exports = { deobfuscate, parse, generateCode };
