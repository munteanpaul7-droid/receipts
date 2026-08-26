/* Return reminders and the Drive-connection banner. The reminder is the one
   part of this app that writes outside Drive, so what it sends to Google and
   when it refuses to send anything both matter. */
const { freshEnv } = require('./harness');
const vm = require('vm');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };

function env(opts) {
  opts = opts || {};
  const c = freshEnv();
  c._ls.setItem('rc_tok', JSON.stringify('fake'));
  c._ls.setItem('rc_tokExp', JSON.stringify(Date.now() + 3600000));
  c._ls.setItem('rc_granted', JSON.stringify(true));
  if (opts.remind !== false) c._ls.setItem('rc_cfg_remind', JSON.stringify('1'));
  if (opts.lead) c._ls.setItem('rc_cfg_remindDays', JSON.stringify(String(opts.lead)));
  c.sent = null;
  c.ensureToken = () => Promise.resolve();
  c.fetch = (url, o) => {
    c.sent = { url: String(url), body: JSON.parse(o.body) };
    if (opts.status && opts.status !== 200) {
      return Promise.resolve({ ok: false, status: opts.status, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 'ev1', htmlLink: 'x' }) });
  };
  return c;
}

const RECEIPT = {
  name: 'Canadian Tire', cat: 'Tools / Equipment', returnBy: '2026-09-23',
  refund: 62.13, terms: 'Returns accepted within 30 days with receipt.',
  addr: '2555 Bank St, Ottawa ON', phone: '(613) 555-0134'
};

(async () => {
console.log('\n== the reminder lands a few days before the deadline ==');
{
  const c = env({ lead: 3 });
  const ev = await c.addReturnReminder(RECEIPT);
  ok('an event was created', !!ev, ev);
  ok('on the primary calendar', /calendars\/primary\/events/.test(c.sent.url), c.sent.url);
  ok('three days early', c.sent.body.start.date === '2026-09-20', c.sent.body.start);
  ok('all-day end is the next day', c.sent.body.end.date === '2026-09-21', c.sent.body.end);
  ok('the deadline is in the title', /2026-09-23/.test(c.sent.body.summary), c.sent.body.summary);
  ok('so is what it is for', /Canadian Tire/.test(c.sent.body.summary), c.sent.body.summary);
}

console.log('\n== it asks the question you actually have ==');
{
  const c = env({ lead: 3 });
  await c.addReturnReminder(RECEIPT);
  const d = c.sent.body.description;
  ok('keep it or take it back', /Keep it, or take it back/.test(d), d);
  ok('and for how much', /\$62\.13/.test(d), d);
  ok('what the receipt said is repeated', /within 30 days/.test(d), d);
  ok('with where to take it', /Bank St/.test(d), d);
  ok('and the number to ring', /555-0134/.test(d), d);
  ok('a notification is set, not the calendar default', c.sent.body.reminders.useDefault === false, c.sent.body.reminders);
}

console.log('\n== the lead time is yours to choose ==');
{
  const week = env({ lead: 7 });
  await week.addReturnReminder(RECEIPT);
  ok('a week ahead', week.sent.body.start.date === '2026-09-16', week.sent.body.start);

  const day = env({ lead: 1 });
  await day.addReturnReminder(RECEIPT);
  ok('a day ahead', day.sent.body.start.date === '2026-09-22', day.sent.body.start);
}

console.log('\n== nothing is written unless it was asked for ==');
{
  const off = env({ remind: false });
  const ev = await off.addReturnReminder(RECEIPT);
  ok('reminders off means no event', ev === null, ev);
  ok('and nothing sent to Google', off.sent === null, off.sent);

  const noDate = env({ lead: 3 });
  const ev2 = await noDate.addReturnReminder(Object.assign({}, RECEIPT, { returnBy: '' }));
  ok('no return date means no event', ev2 === null, ev2);
  ok('and nothing sent', noDate.sent === null, noDate.sent);
}

console.log('\n== the calendar permission is only requested when wanted ==');
{
  const off = env({ remind: false });
  ok('Drive alone by default', off.scopeWanted() === 'https://www.googleapis.com/auth/drive.file', off.scopeWanted());
  const on = env({ lead: 3 });
  ok('calendar added when switched on', /calendar\.events/.test(on.scopeWanted()), on.scopeWanted());
  ok('and Drive is still there', /drive\.file/.test(on.scopeWanted()), on.scopeWanted());
}

console.log('\n== a refused permission says which one ==');
{
  const c = env({ lead: 3, status: 403 });
  let err = null;
  try { await c.addReturnReminder(RECEIPT); } catch (e) { err = e.message; }
  ok('403 names the calendar', err === 'calendar-not-granted', err);

  const c2 = env({ lead: 3, status: 401 });
  let err2 = null;
  try { await c2.addReturnReminder(RECEIPT); } catch (e) { err2 = e.message; }
  ok('401 is a lapsed sign-in', err2 === 'auth-expired', err2);
}

console.log('\n== the red banner appears exactly when Drive is down ==');
{
  const c = freshEnv();
  const cls = () => c._els.offWarn.className;

  /* accessToken and tokenExp are read into module scope once at load, so the
     live values have to be set the way requestToken sets them, not through
     localStorage after the fact. */
  c._ls.setItem('rc_granted', JSON.stringify(true));
  vm.runInContext('accessToken = "fake"; tokenExp = 0;', c);
  c.paintStatus();
  ok('lapsed sign-in shows red', !/hide/.test(cls()), cls());
  ok('and says the receipts are safe', /kept on this phone/.test(c._els.offWhy.textContent), c._els.offWhy.textContent);

  vm.runInContext('tokenExp = Date.now() + 3600000;', c);
  c.paintStatus();
  ok('connected hides it', /hide/.test(cls()), cls());

  const fresh = freshEnv();
  fresh.paintStatus();
  ok('a fresh install is not shouted at', /hide/.test(fresh._els.offWarn.className), fresh._els.offWarn.className);
}

console.log('\n' + (fail ? 'FAILED ' + fail : 'all ' + pass + ' passed'));
process.exit(fail ? 1 : 0);
})();
