(() => {
  const _A =
    "!#$%&()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~";

  const _b64d = s => {
    if (typeof atob === "function") return atob(s);
    return Buffer.from(s, "base64").toString("binary");
  };

  const _rc4 = (key, str) => {
    const s = Array.from({ length: 256 }, (_, i) => i);
    let j = 0;

    for (let i = 0; i < 256; i++) {
      j = (j + s[i] + key.charCodeAt(i % key.length)) & 255;
      [s[i], s[j]] = [s[j], s[i]];
    }

    let i = 0;
    j = 0;
    let out = "";

    for (let y = 0; y < str.length; y++) {
      i = (i + 1) & 255;
      j = (j + s[i]) & 255;

      [s[i], s[j]] = [s[j], s[i]];

      const k = s[(s[i] + s[j]) & 255];
      out += String.fromCharCode(str.charCodeAt(y) ^ k);
    }

    return out;
  };

  const _xor = (arr, key) =>
    arr.map((x, i) =>
      x ^ ((key + i * 31) & 255)
    );

  const _unxor = (arr, key) =>
    arr.map((x, i) =>
      x ^ ((key + i * 31) & 255)
    );

  const _str = arr =>
    String.fromCharCode(...arr);

  const _deadNoise = (() => {
    let x = 0x13579bdf;

    return () => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;

      return x >>> 0;
    };
  })();

  const _opaque = n => {
    const x = (n * n + n) & 1;
    return x === 0;
  };

  const _fake92decode = s => {
    let acc = 0;
    let bits = 0;
    const out = [];

    for (const c of s) {
      const v = _A.indexOf(c);

      if (v < 0) continue;

      acc = ((acc << 7) | (v & 127)) >>> 0;
      bits += 7;

      while (bits >= 8) {
        bits -= 8;
        out.push((acc >>> bits) & 255);
      }
    }

    return out;
  };

  const _decoys = [
    "q!9#Z$7^M@x~",
    "n]Q?4{A&2",
    "ZZZZZZZZ",
    "malware",
    "inject",
    "payload"
  ];

  const _noiseResult = _decoys.map(x => {
    try {
      return _fake92decode(x).length;
    } catch {
      return 0;
    }
  });

  if (_noiseResult.reduce((a, b) => a + b, 0) < 0) {
    throw new Error("impossible");
  }

  const _console = _str([
    99, 111, 110, 115, 111, 108, 101
  ]);

  const _log = _str([
    108, 111, 103
  ]);

  const _key = _str([
    107, 51, 121, 95, 57, 50
  ]);

  const _payload = [
    79, 66, 70, 85, 83, 67, 65, 84, 73, 79, 78,
    32,
    66, 79, 83, 83,
    32,
    76, 69, 86, 69, 76,
    32,
    240, 159, 145, 191
  ];

  const _stage1 = _xor(_payload, 73);

  const _stage2 = _unxor(_stage1, 73);

  const _plain = _str(_stage2);

  const _rc4Once = _rc4(_key, _plain);
  const _rc4Twice = _rc4(_key, _rc4Once);

  const _b64 = (() => {
    if (typeof btoa === "function") {
      return btoa(
        unescape(
          encodeURIComponent(_rc4Twice)
        )
      );
    }

    return Buffer
      .from(_rc4Twice, "utf8")
      .toString("base64");
  })();

  const _rebuilt = (() => {
    try {
      const bin = _b64d(_b64);

      if (typeof TextDecoder !== "undefined") {
        const bytes = Uint8Array.from(
          bin,
          c => c.charCodeAt(0)
        );

        return new TextDecoder().decode(bytes);
      }

      return decodeURIComponent(
        escape(bin)
      );
    } catch {
      return _plain;
    }
  })();

  let _state = 0x13;

  const _states = {
    0x13() {
      const r = _deadNoise();

      _state =
        ((r ^ r) === 0)
          ? 0x29
          : 0xff;
    },

    0x29() {
      let z = 0;

      for (let i = 0; i < 64; i++) {
        z ^= (
          Math.imul(i + 1, 0x45d9f3b) >>>
          (i % 7)
        );
      }

      if ((z & 0) !== 0) {
        _state = 0xde;
      } else {
        _state = 0x37;
      }
    },

    0x37() {
      const fake = [
        "ZXZpbA==",
        "aGFja2Vk",
        "cGF5bG9hZA=="
      ];

      fake.forEach(x => {
        try {
          _b64d(x);
        } catch {}
      });

      _state = 0x44;
    },

    0x44() {
      if (!_opaque(1337)) {
        _state = 0xef;
        return;
      }

      _state = 0x51;
    },

    0x51() {
      const checksum =
        [..._rebuilt]
          .reduce(
            (a, c) =>
              (a + c.codePointAt(0)) >>> 0,
            0
          );

      if (checksum === 0xffffffff) {
        _state = 0xba;
      } else {
        _state = 0x63;
      }
    },

    0x63() {
      const obj = globalThis;

      const p1 =
        _console
          .split("")
          .reverse()
          .reverse()
          .join("");

      const p2 =
        _log
          .split("")
          .map(x => x)
          .join("");

      obj[p1][p2](_rebuilt);

      _state = 0x77;
    }
  };

  while (_state !== 0x77) {
    const fn = _states[_state];

    if (typeof fn !== "function") {
      _state = 0x77;
      break;
    }

    fn();
  }

  Object.defineProperty(
    globalThis,
    "_0xBOSS",
    {
      configurable: false,
      enumerable: false,

      get() {
        return [
          66, 65, 83, 69, 57, 50,
          43,
          66, 65, 83, 69, 54, 52,
          43,
          82, 67, 52,
          43,
          88, 79, 82
        ].map(
          String.fromCharCode
        ).join("");
      }
    }
  );

  const _selfCheck = (() => {
    const src =
      Function.prototype.toString
        .call(_rc4);

    return (
      typeof src === "string" &&
      src.length > 10
    );
  })();

  if (!_selfCheck) {
    void _deadNoise();
  }
})();