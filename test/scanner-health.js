const { freshEnv } = require('./harness');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
};

console.log('\n== diagnosis: every failure names a cause and a fix ==');
{
  const c = freshEnv();
  const cases = [
    ['worker deleted (network error)', () => c.explainScanFailure(0, null, true), 'unreachable'],
    ['no key secret',      () => c.explainScanFailure(500, { code: 'no_key' }, false), 'no_key'],
    ['rotated/bad key',    () => c.explainScanFailure(502, { code: 'bad_key' }, false), 'bad_key'],
    ['out of credit',      () => c.explainScanFailure(402, { code: 'credit' }, false), 'credit'],
    ['rate limited',       () => c.explainScanFailure(429, { code: 'rate_limit' }, false), 'rate_limit'],
    ['anthropic 5xx',      () => c.explainScanFailure(502, { code: 'upstream' }, false), 'upstream'],
    ['model retired',      () => c.explainScanFailure(502, { code: 'bad_model' }, false), 'bad_model'],
    ['origin blocked',     () => c.explainScanFailure(403, { code: 'origin' }, false), 'origin'],
    ['old worker, 403',    () => c.explainScanFailure(403, null, false), 'origin'],
    ['wrong URL, 404',     () => c.explainScanFailure(404, null, false), 'unreachable'],
    ['old worker, 5xx',    () => c.explainScanFailure(500, null, false), 'upstream'],
    ['garbage reply',      () => c.explainScanFailure(418, null, false), 'unknown']
  ];
  for (const [name, fn, code] of cases) {
    const r = fn();
    ok(name + ' -> ' + code, r.code === code && !!r.msg && !!r.fix, JSON.stringify(r));
  }
}

console.log('\n== offline is told apart from a dead scanner ==');
{
  const c = freshEnv();
  c.navigator.onLine = false;
  const r = c.explainScanFailure(0, null, true);
  ok('offline is its own case', r.code === 'offline', JSON.stringify(r));
  ok('offline is transient', r.transient === true);
  ok('offline tells you to type it in', /type it in/i.test(r.fix), r.fix);
}

console.log('\n== only worth-waiting failures are retried ==');
{
  const c = freshEnv();
  const t = (code) => (c.explainScanFailure(502, { code }, false).transient === true);
  ok('rate_limit retries', t('rate_limit'));
  ok('upstream retries', t('upstream'));
  ok('bad_key does NOT retry', !t('bad_key'));
  ok('no_key does NOT retry', !t('no_key'));
  ok('credit does NOT retry', !t('credit'));
}

console.log('\n== the breaker trips at three, not before ==');
{
  const c = freshEnv();
  const info = c.explainScanFailure(500, { code: 'no_key' }, false);
  ok('starts closed', !c.scannerOffline());
  c.noteScanFail(info); ok('still closed after 1', !c.scannerOffline());
  c.noteScanFail(info); ok('still closed after 2', !c.scannerOffline());
  c.noteScanFail(info); ok('OPEN after 3', c.scannerOffline());
  ok('remembers the cause', c.scanHealth().code === 'no_key', JSON.stringify(c.scanHealth()));
  c.noteScanOk();
  ok('a success closes it immediately', !c.scannerOffline());
  ok('and forgets the cause', c.scanHealth().fails === 0);
}

console.log('\n== the breaker reopens on its own after the cooldown ==');
{
  const c = freshEnv();
  const info = { code: 'upstream', msg: 'm', fix: 'f' };
  c.noteScanFail(info); c.noteScanFail(info); c.noteScanFail(info);
  ok('open now', c.scannerOffline());
  const h = JSON.parse(c._ls.getItem('rc_scanHealth'));
  ok('cooldown is 15 min', Math.abs((h.until - Date.now()) - 15 * 60000) < 2000, String(h.until - Date.now()));
  // wind the clock past the cooldown
  h.until = Date.now() - 1;
  c._ls.setItem('rc_scanHealth', JSON.stringify(h));
  ok('closed again once it lapses', !c.scannerOffline());
}

console.log('\n== breaker survives a restart (it is on disk, not in memory) ==');
{
  const store = {};
  const a = freshEnv(store);
  const info = { code: 'bad_key', msg: 'm', fix: 'f' };
  a.noteScanFail(info); a.noteScanFail(info); a.noteScanFail(info);
  ok('open before restart', a.scannerOffline());
  const b = freshEnv(store);   // same localStorage, brand new page load
  ok('still open after restart', b.scannerOffline());
}

console.log('\n== Settings tells the truth about each state ==');
{
  const c = freshEnv();
  c.paintScannerState();
  ok('no URL -> says hand entry is fine', /typed in by hand/i.test(c._els.aiState.textContent), c._els.aiState.textContent);
  ok('no URL -> no wake button', /hide/.test(c._els.aiWake.className));

  c._ls.setItem('rc_cfg_aiUrl', JSON.stringify('https://x.workers.dev'));
  c.noteScanOk(); c.paintScannerState();
  ok('healthy -> says so', /working/i.test(c._els.aiState.textContent), c._els.aiState.textContent);

  const info = { code: 'credit', msg: 'The Anthropic account is out of credit.', fix: 'Top it up.' };
  c.noteScanFail(info); c.paintScannerState();
  ok('one failure -> shows cause, no pause', /out of credit/.test(c._els.aiState.textContent) && /hide/.test(c._els.aiWake.className), c._els.aiState.textContent);

  c.noteScanFail(info); c.noteScanFail(info); c.paintScannerState();
  ok('paused -> explains and offers the wake button',
     /Paused/.test(c._els.aiState.textContent) && /out of credit/.test(c._els.aiState.textContent) && c._els.aiWake.className === 'chip',
     c._els.aiState.textContent);
}

console.log('\n' + (fail ? 'FAILED ' + fail : 'all ' + pass + ' passed'));
process.exit(fail ? 1 : 0);
