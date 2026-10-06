// 本地复现 verify-browser 的 eval 管道: new Function('return (' + src + ')')
import fs from 'node:fs';
const src = fs.readFileSync('eval-p1p6.js', 'utf8');
console.log('src bytes:', src.length, 'first:', JSON.stringify(src.slice(0, 40)), 'last:', JSON.stringify(src.slice(-30)));
try {
  const f = new Function(`return (${src})()`);
  console.log('compiled ok');
  // mock 最小 window/document 以观察 resolve 行为(不触浏览器)
  globalThis.window = {
    __bench: { getState: () => ({ mock: 1 }) },
    __snapWanted: false, __snapPixels: null, __snapMeta: null,
    __diag: { snap: 'x' },
    dispatchEvent: () => {},
  };
  globalThis.document = { querySelector: () => null };
  const p = f();
  console.log('call ok, isPromise:', typeof p?.then === 'function');
  const v = await p;
  console.log('resolved keys:', v && Object.keys(v));
} catch (e) {
  console.log('FAILED:', e.message);
}
