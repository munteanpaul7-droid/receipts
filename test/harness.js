/* Loads app.js in a minimal fake browser so the new scanner-failure logic
   can be exercised for real instead of read and hoped over. */
const fs = require('fs'), vm = require('vm'), path = require('path');

function makeEl(id) {
  return { id, value: '', textContent: '', innerHTML: '', className: '', disabled: false,
           dataset: {}, style: {},
           addEventListener(ev, fn) { (this._h || (this._h = {}))[ev] = fn; },
           click() { this._h && this._h.click && this._h.click(); },
           appendChild() {}, removeAttribute() {}, querySelectorAll: () => [] };
}

function freshEnv(store) {
  const els = {};
  const ls = {
    _d: store || {},
    getItem(k) { return k in this._d ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
  };
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, URL,
    localStorage: ls,
    navigator: { onLine: true, clipboard: null },
    location: { origin: 'https://munteanpaul7-droid.github.io',
                pathname: '/receipts/', hash: '', search: '', href: '', replace() {} },
    document: {
      getElementById: (id) => els[id] || (els[id] = makeEl(id)),
      addEventListener() {}, querySelectorAll: () => [],
      createElement: (t) => makeEl(t)
    },
    fetch: () => Promise.reject(new Error('no fetch stubbed')),
    AbortController: undefined,
    _els: els, _ls: ls
  };
  ctx.addEventListener = function () {};
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  return ctx;
}
module.exports = { freshEnv };
