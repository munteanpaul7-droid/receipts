/* The Google Drive OCR round-trip: upload the photo asking for a Doc back,
   export its text, delete the temp file. The deletion matters as much as the
   reading — a stray "~ocr-temp" left in someone's receipts folder is litter
   they have to find and clear themselves. */
const { freshEnv } = require('./harness');
const vm = require('vm');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };

const RECEIPT_TEXT = [
  'RESTAURANT CHEZ ASHTON', 'Quebec QC',
  '2026-08-23',
  'SOUS-TOTAL  24.00', 'TPS 1.20', 'TVQ 2.39', 'TOTAL 27.59'
].join('\n');

function driveEnv(opts) {
  opts = opts || {};
  const c = freshEnv();
  c._ls.setItem('rc_cfg_reader', JSON.stringify('drive'));
  c._ls.setItem('rc_tok', JSON.stringify('fake-token'));
  c._ls.setItem('rc_tokExp', JSON.stringify(Date.now() + 3600000));
  c._ls.setItem('rc_granted', JSON.stringify(true));
  c._ls.setItem('rc_rootId', JSON.stringify('root-folder-id'));
  c.calls = [];
  c.FormData = function () { this._p = []; this._names = []; };
  c.FormData.prototype.append = function (k, v, name) { this._p.push(k); if (name) this._names.push(name); };
  c._lastForm = null;
  c.Blob = function () {};
  c.fetch = (url, o) => {
    const method = (o && o.method) || 'GET';
    c.calls.push(method + ' ' + String(url).split('?')[0]);
    if (String(url).includes('/upload/drive/v3/files')) {
      c._lastForm = o && o.body;
      if (opts.uploadStatus && opts.uploadStatus !== 200) {
        return Promise.resolve({ ok: false, status: opts.uploadStatus, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 'temp-doc-1' }) });
    }
    if (String(url).includes('/export')) {
      if (opts.exportStatus && opts.exportStatus !== 200) {
        return Promise.resolve({ ok: false, status: opts.exportStatus, text: () => Promise.resolve('') });
      }
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(opts.text !== undefined ? opts.text : RECEIPT_TEXT) });
    }
    if (method === 'DELETE') return Promise.resolve({ ok: true, status: 204 });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  };
  // ensureToken/rootFolderId would otherwise try to talk to Google
  c.ensureToken = () => Promise.resolve();
  c.rootFolderId = () => Promise.resolve('root-folder-id');
  vm.runInContext('pending = { blob: { type: "image/jpeg", size: 900 }, ext: "jpg" }', c);
  return c;
}

(async () => {
console.log('\n== the happy path: upload, export, delete ==');
{
  const c = driveEnv();
  const out = await c.tryReadDrive();
  ok('no failure', !out.fail, out.fail);
  ok('merchant read', out.fields.merchant === 'RESTAURANT CHEZ ASHTON', out.fields && out.fields.merchant);
  ok('total read', out.fields.total === 27.59, out.fields && out.fields.total);
  ok('asked Drive for a Doc (that is the OCR)', c.calls.some(x => x.startsWith('POST https://www.googleapis.com/upload/drive/v3/files')), c.calls);
  ok('exported the text', c.calls.some(x => x.includes('/export')), c.calls);
  ok('deleted the temp doc', c.calls.some(x => x.startsWith('DELETE')), c.calls);
}

console.log('\n== tidying up can never cost us a receipt already read ==');
{
  const c = driveEnv();
  const inner = c.fetch;
  c.fetch = (url, o) => {
    /* fetch throwing outright, rather than rejecting — the shape that
       escapes a bare .catch() and would discard the text. */
    if ((o && o.method) === 'DELETE') throw new TypeError('cannot construct');
    return inner(url, o);
  };
  const out = await c.tryReadDrive();
  ok('the receipt still comes back', !out.fail && out.fields.total === 27.59, out.fail || out.fields);
}

console.log('\n== the temp doc is deleted even when reading fails ==');
{
  const c = driveEnv({ exportStatus: 500 });
  const out = await c.tryReadDrive();
  ok('reports a failure', !!out.fail, out);
  ok('still deleted the temp doc', c.calls.some(x => x.startsWith('DELETE')), c.calls);
  ok('treated as worth retrying', out.fail.transient === true, out.fail);
}

console.log('\n== failures are explained, not just numbered ==');
{
  let c = driveEnv({ uploadStatus: 401 });
  let out = await c.tryReadDrive();
  ok('lapsed sign-in -> points at Connect Drive', /Connect Drive/.test(out.fail.fix), out.fail);

  c = driveEnv({ uploadStatus: 403 });
  out = await c.tryReadDrive();
  ok('403 -> reads as a limit, retryable', out.fail.code === 'quota' && out.fail.transient, out.fail);

  c = driveEnv({ text: '' });
  out = await c.tryReadDrive();
  ok('blank OCR -> asks for a better photo', out.fail.code === 'no_text' && /light/i.test(out.fail.fix), out.fail);

  c = driveEnv({ text: 'aaa\nbbb\nccc' });
  out = await c.tryReadDrive();
  ok('text with no amounts -> says type it in', out.fail.code === 'no_fields', out.fail);
  ok('and reassures the photo still uploads', /still uploads/i.test(out.fail.fix), out.fail.fix);

  c = driveEnv();
  c._ls.removeItem('rc_tok'); c._ls.removeItem('rc_granted');
  const c2 = driveEnv();
  c2._ls.setItem('rc_granted', JSON.stringify(false));
  c2._ls.setItem('rc_tokExp', JSON.stringify(0));
  out = await c2.tryReadDrive();
  ok('not connected -> asks you to connect, without calling Google', out.fail.code === 'no_drive' && c2.calls.length === 0, { fail: out.fail, calls: c2.calls });
}

console.log('\n== a hang is stopped by the deadline, not left spinning ==');
{
  /* A request that never comes back is the failure that leaves the spinner
     turning forever. The real deadline is 45s, so the mechanism is proved
     here directly rather than by waiting it out. */
  const c = driveEnv();
  const started = Date.now();
  let err = null;
  try { await c.withDeadline(new Promise(() => {}), 200); } catch (e) { err = e; }
  ok('a promise that never settles is rejected', err !== null);
  ok('rejected as a timeout', err && err.message === 'timeout', err && err.message);
  ok('rejected promptly', Date.now() - started < 2000, String(Date.now() - started));

  ok('a slower-than-deadline read loses to it',
     await c.withDeadline(Promise.resolve('quick'), 200) === 'quick');

  const info = c.explainDriveFailure(new Error('timeout'));
  ok('a timeout is explained', /took too long/i.test(info.msg), info);
  ok('and is worth retrying', info.transient === true, info);
  ok('and says what to do', /try again|type it in/i.test(info.fix), info.fix);
}

console.log('\n== an emailed PDF receipt is read too ==');
{
  const c = driveEnv();
  vm.runInContext('pending = { blob: { type: "application/pdf", size: 5000 }, ext: "pdf" }', c);
  const out = await c.tryReadDrive();
  ok('the PDF is read, not skipped', !out.fail && out.fields.total === 27.59, out.fail || out.fields);
  ok('sent to Drive named as a PDF', c._lastForm && c._lastForm._names.indexOf('receipt.pdf') >= 0,
     c._lastForm && c._lastForm._names);
}

console.log('\n== a photo is still sent as a photo ==');
{
  const c = driveEnv();
  await c.tryReadDrive();
  ok('named as a jpg', c._lastForm && c._lastForm._names.indexOf('receipt.jpg') >= 0,
     c._lastForm && c._lastForm._names);
}

console.log('\n== offline is not treated as a broken scanner ==');
{
  const c = driveEnv();
  c.navigator.onLine = false;
  c.fetch = () => Promise.reject(new Error('Failed to fetch'));
  const out = await c.tryReadDrive();
  ok('recognised as offline', out.fail.code === 'offline', out.fail);
  ok('says saving still works', /offline/i.test(out.fail.fix), out.fail.fix);
}

console.log('\n' + (fail ? 'FAILED ' + fail : 'all ' + pass + ' passed'));
process.exit(fail ? 1 : 0);
})();
