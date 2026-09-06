#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const chalk = require('chalk');
const { deobfuscate } = require('./index');
const { tryProcessZip, isZipFile } = require('./zip');

program
  .name('deob')
  .description('JavaScript deobfuscation tool')
  .version('1.0.0')
  .argument('[input]', 'input file (JS or ZIP archive)')
  .option('-o, --output <file>', 'output file (or output directory for ZIPs)')
  .option('--stdin', 'read from stdin')
  .option('--rounds <n>', 'number of deobfuscation rounds', '3')
  .option('--no-string-array', 'disable string array decoding')
  .option('--no-packer', 'disable p,a,c,k,e,d packer unpacking')
  .option('--no-control-flow', 'disable control flow unflattening')
  .option('--no-proxy-inline', 'disable proxy inlining')
  .option('--no-proxy-facade', 'disable Proxy facade inlining')
  .option('--no-constant-folding', 'disable constant folding')
  .option('--no-loop-interp', 'disable constant loop interpretation')
  .option('--no-vm-interp', 'disable VM bytecode interpretation')
  .option('--no-dead-code', 'disable dead code elimination')
  .option('--no-mojibake', 'disable mojibake/UTF-8 byte-string fixing')
  .option('--no-inline-iife', 'disable IIFE inlining')
  .option('--no-inline-literals', 'disable single-use literal inlining')
  .option('--no-alias-fold', 'disable const-bound arrow alias folding')
  .option('--no-identity', 'disable identity-pattern resolution (RC4/b64 round trips)')
  .option('--no-const-propagate', 'disable constant propagation')
  .option('--no-state-machine', 'disable state machine linearization')
  .option('--no-dead-store', 'disable dead-store elimination')
  .option('--no-rename', 'disable identifier renaming')
  .option('--no-cleanup', 'disable cleanup')
  .option('--verbose', 'verbose output')
  .parse(process.argv);

const opts = program.opts();

const deobOptions = () => ({
  rounds: parseInt(opts.rounds, 10) || 3,
  stringArray: opts.stringArray,
  packer: opts.packer,
  controlFlow: opts.controlFlow,
  proxyInline: opts.proxyInline,
  proxyFacade: opts.proxyFacade,
  constantFolding: opts.constantFolding,
  loopInterp: opts.loopInterp,
  vmInterp: opts.vmInterp,
  deadCode: opts.deadCode,
  mojibake: opts.mojibake,
  inlineIife: opts.inlineIife,
  inlineLiterals: opts.inlineLiterals,
  aliasFold: opts.aliasFold,
  identity: opts.identity,
  constPropagate: opts.constPropagate,
  stateMachine: opts.stateMachine,
  deadStore: opts.deadStore,
  rename: opts.rename,
  cleanup: opts.cleanup,
  verbose: opts.verbose,
});

function readInput() {
  if (opts.stdin) {
    return fs.readFileSync(0, 'utf8');
  }
  const input = program.args[0];
  if (!input) {
    console.error(chalk.red('error: no input file specified'));
    process.exit(1);
  }
  return fs.readFileSync(path.resolve(input), 'utf8');
}

function main() {
  const input = program.args[0];
  const start = Date.now();

  // ZIP auto-decoder path.
  if (input && !opts.stdin && isZipFile(path.resolve(input))) {
    const outputDir = opts.output
      ? path.resolve(opts.output)
      : path.resolve(path.dirname(input), path.basename(input, path.extname(input)) + '-deob');

    if (opts.verbose) {
      console.error(chalk.cyan(`zip archive detected: ${input}`));
    }

    const processed = tryProcessZip(path.resolve(input), (code) => deobfuscate(code, deobOptions()), outputDir);

    if (processed === null) {
      console.error(chalk.red('error: failed to read archive'));
      process.exit(1);
    }

    const elapsed = Date.now() - start;
    for (const item of processed) {
      console.error(chalk.green(`  ${path.basename(item.file)} -> ${path.join(outputDir, path.basename(item.file))}`));
    }
    console.error(chalk.green(`done: ${processed.length} file(s) in ${elapsed}ms -> ${outputDir}`));
    return;
  }

  // Regular single-file path.
  const code = readInput();
  const result = deobfuscate(code, deobOptions());
  const elapsed = Date.now() - start;

  if (opts.output) {
    fs.writeFileSync(path.resolve(opts.output), result, 'utf8');
    if (opts.verbose) {
      console.error(chalk.green(`done in ${elapsed}ms -> ${opts.output}`));
    }
  } else {
    process.stdout.write(result);
    if (opts.verbose) {
      console.error(chalk.green(`\ndone in ${elapsed}ms`));
    }
  }
}

main();