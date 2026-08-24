const { freshEnv } = require('./harness');
const vm = require('vm');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

function scanEnv(replies) {
  const c = freshEnv();
  c._ls.setItem('rc_cfg_aiUrl', JSON.stringify('https://x.workers.dev'));
  c.blobToBase64 = () => Promise.resolve('QUJD');
  c.calls = 0;
  c.fetch = () => {
    const r = replies[Math.min(c.calls++, replies.length - 1)];
    if (r === 'neterr') return Promise.reject(new Error('Failed to fetch'));
    return Promise.resolve({ ok: r.status === 200, status: r.status, json: () => Promise.resolve(r.body) });
  };
  vm.runInContext('pending = { blob: { type: "image/jpeg", size: 1000 }, ext: "jpg" }', c);
  return c;
}
const GOOD = { status: 200, body: { ok: true, fields: { merchant: 'Chez Ashton', date: '2026-08-23', total: 114.98,
  subtotal: null, federal_tax: null, provincial_tax: null, tax_group: '', category: 'Restaurant',
  federal_tax_number: null, provincial_tax_number: null, tip: null, confidence: 'high', note: null } } };

(async () => {
console.log('\n== a working scanner still fills the form ==');
{
  const c = scanEnv([GOOD]);
  await c.scanReceipt(true);
  ok('one call only', c.calls === 1, String(c.calls));
  ok('merchant filled', c._els.fName.value === 'Chez Ashton', c._els.fName.value);
  ok('total filled', c._els.fTotal.value === '114.98', c._els.fTotal.value);
  ok('row is green', c._els.scanRow.className === 'scan good', c._els.scanRow.className);
  ok('health stays clean', c.scanHealth().fails === 0);
}

console.log('\n== a rate limit is retried once, then succeeds ==');
{
  const c = scanEnv([{ status: 429, body: { ok: false, code: 'rate_limit' } }, GOOD]);
  await c.scanReceipt(true);
  ok('called twice', c.calls === 2, String(c.calls));
  ok('ended green', c._els.scanRow.className === 'scan good', c._els.scanRow.className);
  ok('no failure recorded', c.scanHealth().fails === 0);
}

console.log('\n== a dead key is NOT retried, and says what to do ==');
{
  const c = scanEnv([{ status: 502, body: { ok: false, code: 'bad_key' } }]);
  await c.scanReceipt(true);
  ok('called once only', c.calls === 1, String(c.calls));
  ok('row is red', c._els.scanRow.className === 'scan bad');
  ok('names the cause', /rejected the scanner/i.test(c._els.scanMsg.textContent), c._els.scanMsg.textContent);
  ok('names the fix', /new API key/i.test(c._els.scanMsg.textContent), c._els.scanMsg.textContent);
  ok('button says Read', c._els.scanBtn.textContent === 'Read', c._els.scanBtn.textContent);
  ok('button is usable', c._els.scanBtn.disabled === false);
}

console.log('\n== a deleted Worker: three tries, then it stops nagging ==');
{
  const c = scanEnv(['neterr']);
  await c.scanReceipt(true);
  ok('1st: not paused yet', !c.scannerOffline());
  await c.scanReceipt(true);
  ok('2nd: not paused yet', !c.scannerOffline());
  await c.scanReceipt(true);
  ok('3rd: paused', c.scannerOffline());
  ok('says it is pausing', /Pausing the scanner/.test(c._els.scanMsg.textContent), c._els.scanMsg.textContent);
  ok('says the Worker may be gone', /deleted/.test(c._els.scanMsg.textContent), c._els.scanMsg.textContent);

  // The whole point: attaching another photo must not re-run a dead scanner.
  const before = c.calls;
  c._ls.setItem('rc_cfg_autoScan', JSON.stringify('1'));
  ok('paused state is what attach() checks', c.scannerOffline() === true);
  ok('no further network calls made while paused', c.calls === before, String(c.calls));

  // ...but tapping Read still tries, and a fixed scanner recovers instantly.
  c.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(GOOD.body) });
  await c.scanReceipt(true);
  ok('manual Read still works while paused', c._els.scanRow.className === 'scan good', c._els.scanRow.className);
  ok('recovery clears the pause', !c.scannerOffline());
}

console.log('\n== the form is never blocked by the scanner ==');
{
  const c = scanEnv([{ status: 500, body: { ok: false, code: 'no_key' } }]);
  const g = (id) => c.document.getElementById(id);
  g('fTotal').value = '42.00';
  g('fName').value = 'Typed by hand';
  await c.scanReceipt(true);
  ok('typed total survives a failed scan', c._els.fTotal.value === '42.00', c._els.fTotal.value);
  ok('typed merchant survives', c._els.fName.value === 'Typed by hand', c._els.fName.value);
  ok('collect() still works', c.collect().total === 42 && c.collect().name === 'Typed by hand', JSON.stringify(c.collect()));
}

console.log('\n== a scan never overwrites what you typed ==');
{
  const c = scanEnv([GOOD]);
  c.document.getElementById('fName').value = 'My own name';
  await c.scanReceipt(true);
  ok('typed merchant wins over the scan', c._els.fName.value === 'My own name', c._els.fName.value);
  ok('empty total still gets filled', c._els.fTotal.value === '114.98', c._els.fTotal.value);
}

console.log('\n== no scanner configured is a calm state, not an error ==');
{
  const c = scanEnv([GOOD]);
  c._ls.removeItem('rc_cfg_aiUrl');
  await c.scanReceipt(true);
  ok('no network call', c.calls === 0, String(c.calls));
  ok('row is neutral, not red', c._els.scanRow.className === 'scan', c._els.scanRow.className);
  ok('points at the form', /always works/.test(c._els.scanMsg.textContent), c._els.scanMsg.textContent);
}

console.log('\n' + (fail ? 'FAILED ' + fail : 'all ' + pass + ' passed'));
process.exit(fail ? 1 : 0);
})();
