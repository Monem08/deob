'use strict';

const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const generate = require('@babel/generator').default;

/**
 * Parse JavaScript source into a Babel AST.
 */
function parse(code) {
  return parser.parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowSuperOutsideMethod: true,
    allowUndeclaredExports: true,
    errorRecovery: true,
    plugins: [
      'jsx',
      'typescript',
      'asyncGenerators',
      'bigInt',
      'classProperties',
      'classPrivateProperties',
      'classPrivateMethods',
      'dynamicImport',
      'importMeta',
      'logicalAssignment',
      'nullishCoalescingOperator',
      'numericSeparator',
      'objectRestSpread',
      'optionalCatchBinding',
      'optionalChaining',
      'topLevelAwait',
      'decorators-legacy',
    ],
  });
}

/**
 * Generate source from a Babel AST.
 */
function generateCode(ast) {
  return generate(ast, {
    comments: false,
    compact: false,
    concise: false,
    jsescOption: { minimal: true },
    retainLines: false,
  }).code;
}

module.exports = { parse, generateCode, t, traverse };
