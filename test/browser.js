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
const os = require('os');
const path = require('path');

/* Both fixtures are built here rather than assumed to exist. A test that
   silently depends on a file someone once put in /tmp passes on the machine
   that made it and quietly skips its checks everywhere else. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-test-'));
const JPG = path.join(TMP, 'receipt.jpg');
const PDF = path.join(TMP, 'receipt.pdf');

function writePdfFixture(file) {
  const content = Buffer.from(
    'BT /F1 14 Tf 40 200 Td 18 TL\n(SOUS-TOTAL 24.00) Tj T*\n(TPS 1.20) Tj T*\n' +
    '(TVQ 2.39) Tj T*\n(TOTAL 27.59) Tj T*\nET');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 260] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = pdf.length;
  pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  offsets.forEach((o) => { pdf += String(o).padStart(10, '0') + ' 00000 n \n'; });
  pdf += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  fs.writeFileSync(file, pdf, 'latin1');
}

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
  fs.writeFileSync(JPG, jpg);
  writePdfFixture(PDF);
  await page.setInputFiles('#libIn', JPG);
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
    const TEXT = ['RESTAURANT CHEZ ASHTON', '830 Boul Charest Est', 'Quebec, QC  G1K 3J7',
                  'Tel: (418) 522-3449', '2026-08-23  18:42',
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
  await page.setInputFiles('#libIn', JPG);
  await page.waitForTimeout(2500);
  ok('merchant filled from OCR', (await page.inputValue('#fName')) === 'RESTAURANT CHEZ ASHTON', await page.inputValue('#fName'));
  ok('total filled', (await page.inputValue('#fTotal')) === '27.59', await page.inputValue('#fTotal'));
  ok('TPS filled', (await page.inputValue('#fTps')) === '1.20', await page.inputValue('#fTps'));
  ok('TVQ filled', (await page.inputValue('#fTvq')) === '2.39', await page.inputValue('#fTvq'));
  ok('date filled', (await page.inputValue('#fDate')) === '2026-08-23', await page.inputValue('#fDate'));
  ok('province set to Quebec', (await page.inputValue('#fTax')) === 'QC', await page.inputValue('#fTax'));
  ok('address filled', (await page.inputValue('#fAddr')) === '830 Boul Charest Est, Quebec, QC G1K 3J7', await page.inputValue('#fAddr'));
  ok('phone filled', (await page.inputValue('#fPhone')) === '(418) 522-3449', await page.inputValue('#fPhone'));
  ok('time filled', (await page.inputValue('#fTime')) === '18:42', await page.inputValue('#fTime'));
  ok('time reaches the saved record', await page.evaluate(() => collect().time === '18:42'));
  ok('known addresses are offered as you type', await page.evaluate(() => {
    rememberVendor(collect());
    paintMerchants();
    const opts = [...document.getElementById('addresses').options].map(o => o.value);
    return opts.includes('830 Boul Charest Est, Quebec, QC G1K 3J7');
  }));
  ok('address and phone reach the saved record', await page.evaluate(() => {
    const m = collect();
    return m.addr === '830 Boul Charest Est, Quebec, QC G1K 3J7' && m.phone === '(418) 522-3449';
  }));
  ok('and are remembered for that merchant', await page.evaluate(() => {
    rememberVendor(collect());
    const v = JSON.parse(localStorage.getItem('rc_vendors'))['restaurant chez ashton'];
    return !!v && v.addr === '830 Boul Charest Est, Quebec, QC G1K 3J7' && v.phone === '(418) 522-3449';
  }));
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
  await page.setInputFiles('#libIn', PDF);
  await page.waitForTimeout(2500);
  ok('the PDF preview card is shown', await page.isVisible('#prevPdf'));
  ok('total read from the PDF', (await page.inputValue('#fTotal')) === '27.59', await page.inputValue('#fTotal'));
  ok('TPS read from the PDF', (await page.inputValue('#fTps')) === '1.20', await page.inputValue('#fTps'));
  ok('TVQ read from the PDF', (await page.inputValue('#fTvq')) === '2.39', await page.inputValue('#fTvq'));
  ok('row went green', (await page.getAttribute('#scanRow', 'class')).includes('good'), await page.getAttribute('#scanRow', 'class'));
  ok('temp doc deleted', await page.evaluate(() => window.__pdfDeleted));
  await page.screenshot({ path: '/tmp/receipts-shot-pdf.png' });

  console.log('\n== business-name suggestions ==');
  await page.evaluate(() => {
    localStorage.setItem('rc_cfg_lookup', JSON.stringify('osm'));
    ['fName','fAddr','fPhone'].forEach(id => document.getElementById(id).value = '');
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const real = window.fetch;
    window.__looked = 0;
    window.fetch = (u, o) => {
      if (String(u).includes('photon')) {
        window.__looked++;
        return Promise.resolve(new Response(JSON.stringify({ features: [
          { properties: { name: 'Restaurant Chez Ashton', housenumber: '830',
                          street: 'Boulevard Charest Est', city: 'Quebec', postcode: 'G1K 3J7' } }
        ] }), { status: 200 }));
      }
      return real(u, o);
    };
  });
  await page.click('#fName');
  await page.type('#fName', 'chez ash', { delay: 30 });
  await page.waitForTimeout(1200);
  ok('a suggestion appears', await page.isVisible('#suggBox .nm'), await page.textContent('#suggBox'));
  ok('typing was debounced into one lookup', await page.evaluate(() => window.__looked) === 1,
     await page.evaluate(() => window.__looked));
  await page.click('#suggBox button');
  await page.waitForTimeout(300);
  ok('tapping it fills the name', (await page.inputValue('#fName')) === 'Restaurant Chez Ashton', await page.inputValue('#fName'));
  ok('and the address', /830 Boulevard Charest Est/.test(await page.inputValue('#fAddr')), await page.inputValue('#fAddr'));
  ok('the list closes again', !(await page.isVisible('#suggBox .nm')));

  ok('a typed address is never overwritten', await page.evaluate(async () => {
    document.getElementById('fName').value = '';
    document.getElementById('fAddr').value = 'MY OWN ADDRESS';
    const inp = document.getElementById('fName');
    inp.value = 'chez ash';
    inp.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 1000));
    document.querySelector('#suggBox button').click();
    return document.getElementById('fAddr').value === 'MY OWN ADDRESS';
  }));

  console.log('\n== the calendar button on the return part ==');
  await page.evaluate(() => {
    localStorage.setItem('rc_cfg_remind', JSON.stringify('1'));
    localStorage.setItem('rc_cfg_remindDays', JSON.stringify('3'));
    localStorage.setItem('rc_tok', JSON.stringify('fake'));
    localStorage.setItem('rc_tokExp', JSON.stringify(Date.now() + 3600000));
    localStorage.setItem('rc_granted', JSON.stringify(true));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(600);

  ok('hidden while there is no return date', !(await page.isVisible('#calBtn')));

  await page.evaluate(() => {
    document.getElementById('fName').value = 'Canadian Tire';
    document.getElementById('fTotal').value = '62.13';
    document.getElementById('fRefund').value = '62.13';
    const d = document.getElementById('fReturnBy');
    d.value = '2026-09-23';
    d.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(200);
  ok('appears once a return date is set', await page.isVisible('#calBtn'));
  ok('and is labelled plainly', (await page.textContent('#calBtn')).trim() === 'Add return date to your calendar',
     await page.textContent('#calBtn'));
  ok('and is green, like Save', await page.evaluate(() => {
    const c = getComputedStyle(document.getElementById('calBtn')).backgroundColor;
    const m = c.match(/\d+/g).map(Number);
    return m[1] > m[0] && m[1] > m[2];   // more green than red or blue
  }), await page.evaluate(() => getComputedStyle(document.getElementById('calBtn')).backgroundColor));
  ok('the days left are spelled out', /day/.test(await page.textContent('#returnNote')), await page.textContent('#returnNote'));

  await page.evaluate(() => {
    window.__cal = null;
    const real = window.fetch;
    window.fetch = (u, o) => {
      if (String(u).includes('calendar/v3')) {
        window.__cal = JSON.parse(o.body);
        return Promise.resolve(new Response(JSON.stringify({ id: 'ev1' }), { status: 200 }));
      }
      return real(u, o);
    };
  });
  await page.click('#calBtn');
  await page.waitForTimeout(700);
  const ev = await page.evaluate(() => window.__cal);
  ok('tapping it creates the event', !!ev, ev);
  ok('three days before the deadline', ev && ev.start.date === '2026-09-20', ev && ev.start);
  ok('naming the shop and the date', ev && /Canadian Tire/.test(ev.summary) && /2026-09-23/.test(ev.summary), ev && ev.summary);
  ok('and asking keep or return, for how much', ev && /Keep it, or take it back/.test(ev.description) && /\$62\.13/.test(ev.description), ev && ev.description);

  console.log('\n== the connection notice announces and withdraws ==');
  ok('a lapse shows the red notice, then takes it away', await page.evaluate(async () => {
    const el = document.getElementById('offWarn');
    localStorage.setItem('rc_granted', JSON.stringify(true));
    tokenExp = Date.now() + 3600000; accessToken = 'fake';
    paintStatus();                       // seen as connected
    tokenExp = 0;                        // the sign-in lapses
    paintStatus();
    const shown = !el.className.includes('hide');
    await new Promise(r => setTimeout(r, 3300));
    const fading = el.className.includes('fade');
    await new Promise(r => setTimeout(r, 800));
    const gone = el.className.includes('hide');
    return shown && fading && gone;
  }));
  ok('the dot is what stays', await page.evaluate(() =>
    !document.getElementById('dot').className.includes('on')));

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
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + (fail ? 'FAILED ' + fail : 'all ' + pass + ' passed'));
  process.exit(fail ? 1 : 0);
})();
