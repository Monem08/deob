# deob

**A god-tier static JavaScript deobfuscator.** Give it obfuscated code — string arrays, packers, virtual machines, runtime crypto theater, state machines — and it reconstructs near-original source. No execution of foreign code, no `eval` of payloads, no guessing. Every transformation proves its safety before it fires.

```
obfuscated:  30 lines of VM bytecode + dispatch loop + stack machinery
output:      console.log("LEVEL GOD");
```

---

## What it defeats

| Tier | Technique | Pass(es) |
|---|---|---|
| 1 | Hex/unicode escapes, mojibake (UTF-8 byte-strings) | `mojibake`, `constant-folding` |
| 2 | String arrays + rotation IIFEs + index decoders (`n^90`, `n-0x81`) | `string-array` |
| 3 | Dean Edwards packers (`p,a,c,k,e,d`) | `packer` |
| 4 | `switch` dispatchers, numeric-key state machines | `control-flow`, `state-machine` |
| 5 | Proxy facades (arithmetic/method), identity proxies over globals | `proxy-facade`, `proxy-inline` |
| 6 | Runtime crypto theater — RC4 double-apply, b64/utf8 round trips, XOR chains | `identity`, `loop-interp` |
| 7 | Custom virtual machines (opcode dispatch, stack, registers) | `vm-interp` |
| — | Dead code, opaque predicates, alias chains, unicode identifiers | `dead-code`, `dead-store`, `const-propagate`, `alias-fold`, `inline-*`, `rename`, `cleanup` |

### Signature moves

- **String array decoding, done right** — detects all three rotation shapes (`while(--n)`, `while(n--)`, `f(++n)`), bakes the rotation back into the AST so multi-round decoding stays consistent, and resolves arrow decoders by *substituting the argument into the body and evaluating* — any index expression shape works.
- **Native packer unpack** — the canonical `eval(function(p,a,c,k,e,d){...})` is unpacked with a faithful reimplementation of the algorithm (base-N encoder incl. the `>35 → charCode+29` alphabet, radix up to 62, whole-word `\b` substitution). The unpacked source is then run through the rest of the pipeline.
- **VM interpreter** — recognizes `while(true){switch(bytecode[pc++]){...}}` machines with constant programs, symbolically executes them (64k-step budget), and emits the reconstructed straight-line code. Pop-order quirks are simulated faithfully.
- **Constant loop interpreter** — bounded, side-effect-free for-loops (XOR-decrypt chains, accumulator pushes) are executed at deobfuscation time and their results materialized as literals.
- **Identity resolution** — RC4 applied twice with the same key cancels. `b64decode(b64encode(x))` cancels — *regardless of spelling* (atob/Buffer/TextDecoder/unescape idioms, typeof-branch wrappers, try/catch resilient decoders). The theater evaporates.
- **Mutation safety** — arrays resolve through identifiers only when a binding-level scan proves nothing ever mutates them. This prevents the worst failure mode: silently folding `arr.push(...)` loops against stale data.
- **Boolean preservation** — `!!x` only folds when `x` is provably boolean-typed. `return !!i` stays `return !!i` — because APIs like Chrome's `runtime.onMessage` require a literal boolean to keep the `sendResponse` channel open, and a deobfuscator must never change program semantics.

---

## Install

```bash
git clone https://github.com/Monem089/deob.git
cd deob
npm install
```

Requires Node.js ≥ 18.

```bash
# run from source
npm run deob -- input.js -o output.js

# or link the CLI globally
npm link
deob input.js -o output.js
```

## Usage

```bash
# single file
node src/cli.js input.js -o output.js

# print to stdout
node src/cli.js input.js

# stdin
cat input.js | node src/cli.js --stdin

# ZIP archive — auto-detected, extracted recursively (nested zips too),
# every .js/.mjs/.cjs/.jsx/.ts deobfuscated, structure preserved
node src/cli.js bundle.zip -o outdir/
```

### Options

```
  -o, --output <file>    output file (or output directory for ZIPs)
  --stdin                read from stdin
  --rounds <n>           deobfuscation rounds (default 3)
  --no-string-array      disable string array decoding
  --no-packer            disable p,a,c,k,e,d packer unpacking
  --no-control-flow      disable control flow unflattening
  --no-proxy-inline      disable proxy inlining
  --no-proxy-facade      disable Proxy facade inlining
  --no-constant-folding  disable constant folding
  --no-loop-interp       disable constant loop interpretation
  --no-vm-interp         disable VM bytecode interpretation
  --no-dead-code         disable dead code elimination
  --no-mojibake          disable mojibake/UTF-8 byte-string fixing
  --no-inline-iife       disable IIFE inlining
  --no-inline-literals   disable single-use literal inlining
  --no-alias-fold        disable const-bound arrow alias folding
  --no-identity          disable identity-pattern resolution (RC4/b64 round trips)
  --no-const-propagate   disable constant propagation
  --no-state-machine     disable state machine linearization
  --no-dead-store        disable dead-store elimination
  --no-rename            disable identifier renaming
  --no-cleanup           disable cleanup
  --verbose              verbose output
```

Every pass is individually toggleable — strip the pipeline back for a specific target, or inspect what each pass contributes.

### Library API

```js
const { deobfuscate } = require('./src/index');

const source = fs.readFileSync('obfuscated.js', 'utf8');
const result = deobfuscate(source, { rounds: 3, verbose: true });
```

---

## Architecture

```
src/
  cli.js                  CLI entry, ZIP auto-decoder dispatch
  index.js                pipeline orchestration (20 passes, multi-round)
  evaluator.js            static expression evaluator (+ mutation safety, alias chains)
  utils.js                parse / generate wrappers
  zip.js                  ZIP sniffing + recursive extraction
  transforms/
    string-array.js       string arrays, rotations, decoders
    packer.js             p,a,c,k,e,d native unpack
    control-flow.js       switch-dispatcher unflattening
    proxy-inline.js       wrapper function inlining
    proxy-facade.js       Proxy facades + identity proxies
    alias-fold.js         const-bound arrow evaluation
    constant-folding.js   folding + opaque predicates + self-cancel rules
    loop-interp.js        bounded loop interpretation
    vm-interp.js          VM bytecode interpretation
    identity.js           RC4/b64 round-trip resolution
    const-propagate.js    constant/alias propagation
    state-machine.js      state machine linearization
    dead-code.js          unreachable branch elimination
    mojibake.js           UTF-8 byte-string repair
    inline-iife.js        IIFE unwrapping
    inline-literals.js    single-use literal inlining
    dead-store.js         write-only variable elimination
    rename.js             readable identifier renaming (incl. unicode)
    cleanup.js            notation cleanup (computed→dot, globalThis, !! preservation)
```

**Design principles:**

1. **Conservative by default.** A pass only transforms when it can prove safety. Unknowns are left untouched — a deobfuscator that guesses produces evidence, not truth.
2. **Multi-round pipeline.** Passes unlock each other (a fold enables an identity resolution which enables a removal). The AST is re-parsed between rounds so every pass starts from a clean scope cache — in-place mutation across passes leaves Babel's binding data stale.
3. **Semantics are sacred.** No pass may change observable behavior. Type coercions like `!!x` are preserved unless statically provably boolean. The test suite enforces this at the API-contract level, not just output level.

---

## Testing

The repo ships a gauntlet — every sample is a real obfuscation pattern, and every deobfuscated output must **run with output byte-identical to the original**:

```bash
node test/behavioral.js     # Chrome onMessage contract: strict boolean returns,
                           # async sendResponse, storage/badge side effects
```

| Test | Pattern | Verified output |
|---|---|---|
| `boss.js` | RC4 ×2, b64 round trip, state machine, decoys | `OBFUSCATION BOSS LEVEL 👿` |
| `final-boss.js` | unicode ids, Proxy facade, switch dispatch, atob+xor chain | `FINAL_BOSS_DEFEATED::MONEM_IS_THE_DEOBFUSCATION_HERO` |
| `chrome-boss.js` | Chrome extension, identity proxy, base64 array, XOR decoder | behavioral contract suite |
| `vm.js` | custom virtual machine | `LEVEL GOD` |
| `packed.js` | Dean Edwards packer | `PACKED & UNPACKED` |
| `challenge.js`, `sample.js`, `realistic.js`, `stress.js`, `rc4test.js`, `resilient.js` | composites | identical runtime output |

The behavioral test is the interesting one: it deobfuscates a Chrome extension, executes it against a mock `chrome` API, and asserts **strict types** — `assert.strictEqual(result, true)` — because a deobfuscator that turns `return !!i` into `return i` (truthy-equal, strict-unequal) silently breaks the `sendResponse` channel. Truthy tests pass; reality doesn't.

---

## Limitations (honest ones)

- **Self-modifying code** — code that rewrites itself at runtime needs partial evaluation with concrete environment stubs; different architecture, not built.
- **Environment-keyed decryption** — payloads that decrypt differently per runtime (fingerprinted keys) can only be resolved per-environment.
- **WASM-backed VMs** — out of scope for a JS AST tool.
- **`for...of` dispatchers** with interleaved early returns are left readable rather than linearized — the risk of subtly-wrong reordering outweighs the cosmetic gain.
- Heavily entangled code (functions referenced via `Function.prototype.toString` self-checks, intentionally-observable decoy calls) is **correctly** left intact — removing it would change program behavior.

## License

MIT