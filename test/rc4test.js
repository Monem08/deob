// Minimal RC4 double-apply test for identity pass
const rc4 = (key, str) => {
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

const once = rc4("k", "hello");
const twice = rc4("k", once);
console.log(twice);