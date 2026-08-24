/* Drives the real app in a real browser: does it boot, does a dead scanner
   get diagnosed, does the breaker trip, does the service worker register.
   The other suites stub the DOM; this one is the answer to "but does it
   actually run".

   Optional, because it is the only thing here that needs a dependency:

     node test/serve.js &            # static server on :8099
     npm install playwright-core     # Chromium itself is preinstalled
     node test/browser.js

   Deliberately left out of test/run.sh so that stays dependency-free. */

const { chromium } = require('playwright-core');
const fs = require('fs');

/* The pinned build number changes between images, so discover it. */
function chromePath() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const dir = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
  if (!dir) throw new Error('No Chromium under ' + root);
  return root + '/' + dir + '/chrome-linux/chrome';
}
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

(async () => {
  const browser = await chromium.launch({ executablePath: chromePath() });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  const errors = [], logs = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });

  console.log('\n== the app boots at all ==');
  await page.goto('http://localhost:8099/', { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  ok('no uncaught page errors', errors.length === 0, errors.join(' | '));
  ok('title rendered', (await page.textContent('#title')) === 'New receipt');
  ok('no startup-failure banner', !(await page.getAttribute('#setupWarn', 'class')).includes('bad'),
     await page.getAttribute('#setupWarn', 'class'));
  ok('categories populated', (await page.$$eval('#fCat option', o => o.length)) === 13,
     String(await page.$$eval('#fCat option', o => o.length)));
  ok('tax groups populated', (await page.$$eval('#fTax option', o => o.length)) === 14);
  ok('date defaulted to today', /^\d{4}-\d{2}-\d{2}$/.test(await page.inputValue('#fDate')));
  await page.screenshot({ path: '/tmp/receipts-shot-new.png' });

  console.log('\n== the new Settings controls are really there ==');
  await page.click('.tabs button[data-tab="set"]');
  await page.waitForTimeout(300);
  ok('version shown', /^\d{4}-\d{2}-\d{2}/.test(await page.inputValue('#sVer')), await page.inputValue('#sVer'));
  ok('Check for update present', await page.isVisible('#updBtn'));
  ok('Repair app present', await page.isVisible('#fixBtn'));
  const aiState = await page.textContent('#aiState');
  ok('fresh install reads via Drive', /Google Drive/i.test(aiState), aiState);
  ok('reader picker defaults to Drive', (await page.inputValue('#sReader')) === 'drive');
  ok('Worker URL box hidden for Drive', !(await page.isVisible('#aiOnly')));
  ok('wake chip hidden while healthy', !(await page.isVisible('#aiWake')));
  await page.selectOption('#sReader', 'ai');
  await page.waitForTimeout(200);
  ok('choosing Claude reveals the URL box', await page.isVisible('#aiOnly'));
  ok('choosing Claude reveals the test button', await page.isVisible('#aiTest'));
  await page.selectOption('#sReader', 'drive');
  await page.waitForTimeout(200);
  ok('switching back hides them again', !(await page.isVisible('#aiOnly')));
  await page.screenshot({ path: '/tmp/receipts-shot-settings.png', fullPage: true });

  console.log('\n== the tax maths still works ==');
  await page.click('.tabs button[data-tab="new"]');
  await page.fill('#fTotal', '114.98');
  await page.click('#calcBtn');
  await page.waitForTimeout(200);
  const tps = await page.inputValue('#fTps'), tvq = await page.inputValue('#fTvq');
  ok('TPS split from total', tps === '5.00', tps);
  ok('TVQ split from total', tvq === '9.98', tvq);
  ok('subtotal shown', (await page.textContent('#sub')) === '$100.00', await page.textContent('#sub'));

  console.log('\n== a dead scanner is diagnosed, not just reported ==');
  // Point the app at a scanner URL that refuses connections, then attach a photo.
  await page.evaluate(() => {
    localStorage.setItem('rc_cfg_reader', JSON.stringify('ai'));
    localStorage.setItem('rc_cfg_aiUrl', JSON.stringify('http://localhost:9/dead'));
    localStorage.setItem('rc_cfg_autoScan', JSON.stringify('1'));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(900);

  // a real 2x2 jpeg
  const jpg = Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAIBAREA/8QAHwAAAQUBAQEB' +
    'AQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1Fh' +
    'ByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZ' +
    'WmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG' +
    'x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+v//Z', 'base64');
  fs.writeFileSync('/tmp/receipts-test.jpg', jpg);
  await page.setInputFiles('#libIn', '/tmp/receipts-test.jpg');
  await page.waitForTimeout(2500);

  const msg1 = await page.textContent('#scanMsg');
  ok('names the cause', /never answered|deleted/i.test(msg1), msg1);
  ok('names a next step', /Scanner URL|Settings/i.test(msg1), msg1);
  ok('row went red', (await page.getAttribute('#scanRow', 'class')).includes('bad'));
  ok('Read button usable, not stuck', !(await page.isDisabled('#scanBtn')));
  ok('form still editable after failure', await page.isEditable('#fTotal'));
  await page.screenshot({ path: '/tmp/receipts-shot-scanner-dead.png' });

  console.log('\n== three failures and it stops nagging ==');
  for (let i = 0; i < 2; i++) { await page.click('#scanBtn'); await page.waitForTimeout(1800); }
  const msg3 = await page.textContent('#scanMsg');
  ok('announces the pause', /Pausing the scanner/i.test(msg3), msg3);
  const paused = await page.evaluate(() => JSON.parse(localStorage.getItem('rc_scanHealth')));
  ok('breaker recorded on disk', paused.fails >= 3 && paused.until > Date.now(), JSON.stringify(paused));

  // A fresh photo must NOT trigger another doomed scan.
  await page.click('.tabs button[data-tab="set"]'); await page.waitForTimeout(200);
  const aiState2 = await page.textContent('#aiState');
  ok('Settings explains the pause', /Paused after/.test(aiState2), aiState2);
  ok('offers the wake chip', await page.isVisible('#aiWake'), aiState2);
  await page.screenshot({ path: '/tmp/receipts-shot-paused.png', fullPage: true });

  await page.click('#aiWake'); await page.waitForTimeout(300);
  const woke = await page.evaluate(() => JSON.parse(localStorage.getItem('rc_scanHealth')));
  ok('wake chip clears the pause', woke.fails === 0, JSON.stringify(woke));

  console.log('\n== the free Drive reader fills the form end to end ==');
  await page.evaluate(() => {
    localStorage.setItem('rc_cfg_reader', JSON.stringify('drive'));
    localStorage.setItem('rc_tok', JSON.stringify('fake'));
    localStorage.setItem('rc_tokExp', JSON.stringify(Date.now() + 3600000));
    localStorage.setItem('rc_granted', JSON.stringify(true));
    localStorage.setItem('rc_rootId', JSON.stringify('root-id'));
    localStorage.setItem('rc_scanHealth', JSON.stringify({ fails: 0, until: 0, code: '', msg: '', fix: '' }));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const TEXT = ['RESTAURANT CHEZ ASHTON', 'Quebec QC', '2026-08-23',
                  'SOUS-TOTAL 24.00', 'TPS 1.20', 'TVQ 2.39', 'TOTAL 27.59'].join('\n');
    window.__deleted = false;
    const real = window.fetch;
    window.fetch = (u, o) => {
      const url = String(u), method = (o && o.method) || 'GET';
      if (url.includes('/upload/drive/v3/files'))
        return Promise.resolve(new Response(JSON.stringify({ id: 'tmp1' }), { status: 200 }));
      if (url.includes('/drive/v3/files/root-id'))
        return Promise.resolve(new Response(JSON.stringify({ id: 'root-id', name: 'receipts' }), { status: 200 }));
      if (url.includes('/export')) return Promise.resolve(new Response(TEXT, { status: 200 }));
      if (method === 'DELETE') { window.__deleted = true; return Promise.resolve(new Response('{}', { status: 200 })); }
      return real(u, o);
    };
  });
  await page.setInputFiles('#libIn', '/tmp/receipts-test.jpg');
  await page.waitForTimeout(2500);
  ok('merchant filled from OCR', (await page.inputValue('#fName')) === 'RESTAURANT CHEZ ASHTON', await page.inputValue('#fName'));
  ok('total filled', (await page.inputValue('#fTotal')) === '27.59', await page.inputValue('#fTotal'));
  ok('TPS filled', (await page.inputValue('#fTps')) === '1.20', await page.inputValue('#fTps'));
  ok('TVQ filled', (await page.inputValue('#fTvq')) === '2.39', await page.inputValue('#fTvq'));
  ok('date filled', (await page.inputValue('#fDate')) === '2026-08-23', await page.inputValue('#fDate'));
  ok('province set to Quebec', (await page.inputValue('#fTax')) === 'QC', await page.inputValue('#fTax'));
  ok('row went green', (await page.getAttribute('#scanRow', 'class')).includes('good'), await page.getAttribute('#scanRow', 'class'));
  ok('temp Drive doc was deleted', await page.evaluate(() => window.__deleted));
  await page.screenshot({ path: '/tmp/receipts-shot-drive-filled.png' });

  console.log('\n== an emailed PDF receipt is read the same way ==');
  await page.evaluate(() => {
    /* Verbatim shape of a real Drive PDF conversion: one line, no breaks. */
    const TEXT = 'SOUS-TOTAL 24.00 TPS 1.20 TVQ 2.39 TOTAL 27.59 ';
    window.__pdfDeleted = false;
    const real = window.fetch;
    window.fetch = (u, o) => {
      const url = String(u), method = (o && o.method) || 'GET';
      if (url.includes('/upload/drive/v3/files')) return Promise.resolve(new Response(JSON.stringify({ id: 'tmp2' }), { status: 200 }));
      if (url.includes('/drive/v3/files/root-id')) return Promise.resolve(new Response(JSON.stringify({ id: 'root-id' }), { status: 200 }));
      if (url.includes('/export')) return Promise.resolve(new Response(TEXT, { status: 200 }));
      if (method === 'DELETE') { window.__pdfDeleted = true; return Promise.resolve(new Response('{}', { status: 200 })); }
      return real(u, o);
    };
  });
  await page.click('#prevX');
  await page.evaluate(() => { ['fTotal','fTps','fTvq','fName'].forEach(id => document.getElementById(id).value = ''); });
  await page.setInputFiles('#libIn', '/tmp/receipts-test.pdf');
  await page.waitForTimeout(2500);
  ok('the PDF preview card is shown', await page.isVisible('#prevPdf'));
  ok('total read from the PDF', (await page.inputValue('#fTotal')) === '27.59', await page.inputValue('#fTotal'));
  ok('TPS read from the PDF', (await page.inputValue('#fTps')) === '1.20', await page.inputValue('#fTps'));
  ok('TVQ read from the PDF', (await page.inputValue('#fTvq')) === '2.39', await page.inputValue('#fTvq'));
  ok('row went green', (await page.getAttribute('#scanRow', 'class')).includes('good'), await page.getAttribute('#scanRow', 'class'));
  ok('temp doc deleted', await page.evaluate(() => window.__pdfDeleted));
  await page.screenshot({ path: '/tmp/receipts-shot-pdf.png' });

  console.log('\n== the service worker registers and serves the shell ==');
  const sw = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return r ? { scope: r.scope, active: !!r.active } : null;
  });
  ok('service worker registered', sw && sw.active, JSON.stringify(sw));
  const cached = await page.evaluate(async () => (await caches.keys()));
  ok('cache created with versioned name', cached.some(k => k.startsWith('receipts-')), JSON.stringify(cached));

  console.log('\n== console stayed clean throughout ==');
  ok('no uncaught errors across the whole run', errors.length === 0, errors.join(' | '));
  const realErrors = logs.filter(l => !/accounts\.google\.com|gsi|net::ERR|Failed to load resource/.test(l));
  ok('no unexplained console errors', realErrors.length === 0, realErrors.join(' | '));

  await browser.close();
  console.log('\n' + (fail ? 'FAILED ' + fail : 'all ' + pass + ' passed'));
  process.exit(fail ? 1 : 0);
})();
