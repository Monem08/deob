// Debug: minimal replica of the resilient decoder IIFE
const v0 = "aGVsbG8=";
const rebuilt = (() => {
  try {
    const bin = atob(v0);
    if (typeof TextDecoder !== "undefined") {
      const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }
    return bin;
  } catch {
    return "hello";
  }
})();
console.log(rebuilt);