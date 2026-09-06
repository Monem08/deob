// Behavioral regression: Chrome runtime.onMessage contract.
//
// The onMessage listener's return value must be a literal boolean for
// Chrome to keep the sendResponse channel open. A deobfuscator that
// simplifies `return !!i` to `return i` breaks the contract silently —
// truthy tests pass, strict-typed reality fails.
//
// This test deobfuscates chrome-boss.js, executes the result against a
// chrome mock, and asserts STRICT types.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { deobfuscate } = require('../src/index');

const src = fs.readFileSync(path.join(__dirname, 'chrome-boss.js'), 'utf8');
const out = deobfuscate(src);

// ---- chrome mock ----
const listeners = { installed: null, message: null };
const storageWrites = [];
const badgeCalls = [];

const chrome = {
  runtime: {
    onInstalled: { addListener: (fn) => { listeners.installed = fn; } },
    onMessage: { addListener: (fn) => { listeners.message = fn; } },
  },
  storage: {
    local: {
      set: async (obj) => { storageWrites.push(obj); },
      get: async (key) => ({ [key]: { enabled: true, installedAt: 12345 } }),
    },
  },
  action: {
    setBadgeText: async (o) => { badgeCalls.push(o); },
    setBadgeBackgroundColor: async (o) => { badgeCalls.push(o); },
  },
};

// Run the deobfuscated extension in a scope with the mock.
new Function('chrome', 'Date', 'Promise', out)(chrome, Date, Promise);

assert.ok(listeners.message, 'onMessage listener was registered');

// ---- MONEM_PING path: result must be STRICT boolean true ----
const sends = [];
const result = listeners.message(
  { type: 'MONEM_PING' },
  { tab: { id: 42 } },
  (payload) => sends.push(payload)
);

assert.strictEqual(result, true, 'onMessage return must be strict true');
assert.strictEqual(typeof result, 'boolean', 'onMessage return must be boolean-typed');

// ---- wrong-type path: result must be STRICT boolean false ----
const resultWrong = listeners.message({ type: 'WRONG' }, {}, () => {});
assert.strictEqual(resultWrong, false, 'non-matching message must return strict false');
assert.strictEqual(typeof resultWrong, 'boolean', 'non-matching return must be boolean-typed');

// ---- async contract: sendResponse must actually fire on the PING path ----
setTimeout(() => {
  assert.strictEqual(sends.length, 1, 'sendResponse fired exactly once');
  const payload = sends[0];
  assert.strictEqual(payload.ok, true);
  assert.strictEqual(payload.reply, 'EXTENSION_FINAL_BOSS_DEFEATED_BY_MONEM');
  assert.strictEqual(payload.state.enabled, true);
  assert.strictEqual(payload.tabId, 42);

  // ---- onInstalled side effects ----
  assert.ok(listeners.installed, 'onInstalled listener was registered');
  Promise.resolve(listeners.installed()).then(() => {
    assert.strictEqual(storageWrites.length, 1, 'storage.local.set called once');
    assert.strictEqual(storageWrites[0].monem_extension_state.enabled, true);
    assert.ok(badgeCalls.some((c) => c.text === 'ON'), 'badge text set');
    assert.ok(badgeCalls.some((c) => c.color === '#7c3aed'), 'badge color set');
    console.log('behavioral: ALL PASS');
  });
}, 10);