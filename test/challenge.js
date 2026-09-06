const _0x4f91 = [
  '\x6c\x6f\x67',
  '\x48\x65\x6c\x6c\x6f\x20\x4d\x6f\x6e\x65\x6d\x20\xf0\x9f\x91\xbf'
];

(function (_0xa, _0xb) {
  while (--_0xb) {
    _0xa.push(_0xa.shift());
  }
})(_0x4f91, 0x1337);

const _0xdecode = (i) =>
  _0x4f91[(i ^ 0x2a) % _0x4f91.length];

const _0xrun = (() => {
  const _0xstate = [0x13, 0x37, 0x42, 0x69];

  return function () {
    let _0xdead = 0;

    for (let i = 0; i < _0xstate.length; i++) {
      _0xdead ^= (_0xstate[i] << (i & 3));
    }

    const _0xmsg =
      String.fromCharCode(
        72, 97, 114, 100, 99, 111, 114, 101,
        32, 79, 98, 102, 117, 115, 99, 97,
        116, 105, 111, 110, 32, 240, 159, 145, 191
      );

    globalThis[
      String.fromCharCode(99, 111, 110, 115, 111, 108, 101)
    ][
      String.fromCharCode(108, 111, 103)
    ](_0xmsg);
  };
})();

_0xrun();
