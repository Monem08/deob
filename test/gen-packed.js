// Generates a canonical Dean Edwards packed sample (the common minimal form).
const fs = require('fs');

const words = ['console', 'log', 'PACKED', '&', 'UNPACKED'];
// tokens (radix 62): 0=console 1=log 2=PACKED 3=& 4=UNPACKED
const payload = '0.1(\\"2 3 4\\");';

const eFn = 'function(c){return(c<a?"":e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))}';
const packed =
  'eval(function(p,a,c,k,e,d){' +
  'e=' + eFn + ';' +
  'while(c--)if(k[c])p=p.replace(new RegExp("\\\\b"+e(c)+"\\\\b","g"),k[c]);' +
  'return p' +
  '}("' + payload + '",62,5,"' + words.join('|') + '".split("|"),0,{}))';

fs.writeFileSync('test/packed.js', packed);
console.log('packed.js written, length:', packed.length);