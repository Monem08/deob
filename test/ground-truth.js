// Ground-truth decode of the chrome-boss string array.
const arr = ['cnVudGltZQ==','b25JbnN0YWxsZWQ=','YWRkTGlzdGVuZXI=','c3RvcmFnZQ==','bG9jYWw=','c2V0','YWN0aW9u','c2V0QmFkZ2VUZXh0','dGV4dA==','T04=','c2V0QmFkZ2VCYWNrZ3JvdW5kQ29sb3I=','Y29sb3I=','IzdjM2FlZA==','b25NZXNzYWdl','dHlwZQ==','TU9ORU1fUElORw==','Z2V0','b2s=','cmVwbHk=','RVhURU5TSU9OX0ZJTkFMX0JPU1NfREVGRUFURURfQllfTU9ORU0=','c3RhdGU=','dGFiSWQ=','dGFi','aWQ=','bW9uZW1fZXh0ZW5zaW9uX3N0YXRl','ZW5hYmxlZA==','aW5zdGFsbGVkQXQ='];

// rotation: 7 left shifts
const rotated = [...arr];
for (let i = 0; i < 7; i++) rotated.push(rotated.shift());

const dec = (n) => Buffer.from(rotated[n ^ 90], 'base64').toString('binary');

for (const n of [0x4b, 0x4e, 0x4f, 0x4c, 0x4d, 0x42, 0x43, 0x48, 0x49, 0x40, 0x5a, 0x5b, 0x58, 0x59, 0x5e, 0x5f, 0x5d, 0x52, 0x53, 0x50, 0x51, 0x56, 0x57, 0x54, 0x55, 0x4a]) {
  console.log('0x' + n.toString(16), '->', JSON.stringify(dec(n)));
}