// A canonical switch-dispatch VM obfuscation sample.
// Ops: 0 = push string table entry, 1 = concat top two, 2 = console.log(pop), 3 = exit
(() => {
  const _bc = [
    0, 0,   // push table[0]
    0, 1,   // push table[1]
    0, 2,   // push table[2]
    1,      // concat
    1,      // concat
    2,      // log
    3       // exit
  ];
  const _table = ['GOD', ' ', 'LEVEL'];
  const stack = [];
  let pc = 0;

  while (true) {
    switch (_bc[pc++]) {
      case 0:
        stack.push(_table[_bc[pc++]]);
        continue;
      case 1:
        stack.push(stack.pop() + stack.pop());
        continue;
      case 2:
        console.log(stack.pop());
        continue;
      case 3:
        break;
      default:
        break;
    }
    break;
  }
})();