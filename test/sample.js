// Sample obfuscated code for testing
var _0xabc = ['hello', 'world', 'foo', 'bar'];
function _0xdec(idx) {
  return _0xabc[idx - 0];
}
var _0xflow = '1|0|2|3'.split('|');
var _0xi = 0;
while (true) {
  switch (_0xflow[_0xi++]) {
    case '0':
      var a = _0xdec(0x0);
      continue;
    case '1':
      var b = _0xdec(0x1);
      continue;
    case '2':
      var c = _0xdec(0x2);
      continue;
    case '3':
      var d = _0xdec(0x3);
      break;
  }
  break;
}
function _0xproxy(x) {
  return x + 1;
}
var e = _0xproxy(5);
var f = 2 * 3 + 4;
var g = true && 'yes';
var h = false || 'no';
if (1 === 1) {
  var i = 'kept';
} else {
  var j = 'dropped';
}
console.log(a, b, c, d, e, f, g, h, i);
