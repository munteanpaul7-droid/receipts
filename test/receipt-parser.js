/* The parser that turns Google Drive's OCR text into receipt fields. This
   is where the free reader either earns its keep or doesn't, so the cases
   below are shaped like real Canadian tills: French and English, the tax
   labels of six provinces, change lines, tips, and receipts too poor to
   read. A field that cannot be read must come back empty rather than
   wrong — a wrong total is worse than a blank one. */
const { freshEnv } = require('./harness');
const app = freshEnv();
const { parseReceiptText, findDate, amountsIn } = app;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const today = new Date();
const recent = (d) => { const t = new Date(today); t.setDate(t.getDate() - d);
  return t.getFullYear() + '-' + String(t.getMonth()+1).padStart(2,'0') + '-' + String(t.getDate()).padStart(2,'0'); };
const dmy = (d) => { const t = new Date(today); t.setDate(t.getDate() - d);
  return String(t.getDate()).padStart(2,'0') + '/' + String(t.getMonth()+1).padStart(2,'0') + '/' + t.getFullYear(); };

console.log('\n== amounts are found in every shape a till prints ==');
ok('plain', amountsIn('TOTAL 114.98')[0] === 114.98);
ok('french comma', amountsIn('TOTAL 114,98')[0] === 114.98);
ok('thousands dot-decimal', amountsIn('TOTAL 1,234.56')[0] === 1234.56);
ok('thousands space-comma', amountsIn('TOTAL 1 234,56')[0] === 1234.56);
ok('no separator four digits', amountsIn('TOTAL 1234.56')[0] === 1234.56, amountsIn('TOTAL 1234.56'));
ok('a tax RATE is not an amount', amountsIn('TVQ 9.975%').length === 0, amountsIn('TVQ 9.975%'));
ok('a percentage beside an amount is ignored', amountsIn('TPS 5% 0.50').length === 1 && amountsIn('TPS 5% 0.50')[0] === 0.50, amountsIn('TPS 5% 0.50'));
ok('last amount on the line wins', amountsIn('2 Poutine 10.50 21.00')[1] === 21.00, amountsIn('2 Poutine 10.50 21.00'));

console.log('\n== a Quebec restaurant receipt ==');
{
  const r = parseReceiptText([
    'RESTAURANT CHEZ ASHTON',
    '830 Boul Charest E',
    'Quebec QC G1K 3J7',
    'TPS 123456789 RT0001',
    'TVQ 1234567890 TQ0001',
    '', 'Table 12   Serveur: Marc',
    recent(1) + '  18:42',
    '2 Poutine italienne      21.00',
    '1 Boisson gazeuse         3.00',
    'SOUS-TOTAL               24.00',
    'TPS                       1.20',
    'TVQ                       2.39',
    'TOTAL                    27.59',
    'VISA                     27.59',
    'MERCI DE VOTRE VISITE'
  ].join('\n'));
  ok('merchant', r.merchant === 'RESTAURANT CHEZ ASHTON', r.merchant);
  ok('total', r.total === 27.59, r.total);
  ok('subtotal', r.subtotal === 24.00, r.subtotal);
  ok('TPS', r.federal_tax === 1.20, r.federal_tax);
  ok('TVQ', r.provincial_tax === 2.39, r.provincial_tax);
  ok('province QC', r.tax_group === 'QC', r.tax_group);
  ok('date', r.date === recent(1), r.date);
  ok('TPS number', r.federal_tax_number === '123456789 RT0001', r.federal_tax_number);
  ok('TVQ number', r.provincial_tax_number === '1234567890 TQ0001', r.provincial_tax_number);
  ok('confidence high (maths closes)', r.confidence === 'high', r.confidence);
  ok('no warning note', r.note === null, r.note);
}

console.log('\n== an Ontario HST receipt ==');
{
  const r = parseReceiptText([
    'CANADIAN TIRE #285',
    '2555 Bank St, Ottawa ON',
    'Date: ' + recent(3),
    'Wiper blades            34.99',
    'Motor oil               19.99',
    'SUBTOTAL                54.98',
    'HST 13%                  7.15',
    'TOTAL                   62.13',
    'DEBIT                   62.13'
  ].join('\n'));
  ok('total', r.total === 62.13, r.total);
  ok('HST lands in federal', r.federal_tax === 7.15, r.federal_tax);
  ok('provincial left empty', r.provincial_tax === null, r.provincial_tax);
  ok('province ON from the 13% rate', r.tax_group === 'ON', r.tax_group);
  ok('confidence high', r.confidence === 'high', r.confidence);
}

console.log('\n== a BC receipt: GST + PST at different rates ==');
{
  const r = parseReceiptText([
    'HOME HARDWARE',
    '1200 Robson St, Vancouver BC',
    recent(5),
    'Subtotal               100.00',
    'GST                      5.00',
    'PST                      7.00',
    'Total                  112.00'
  ].join('\n'));
  ok('province BC', r.tax_group === 'BC', r.tax_group);
  ok('GST federal', r.federal_tax === 5.00, r.federal_tax);
  ok('PST provincial', r.provincial_tax === 7.00, r.provincial_tax);
}

console.log('\n== Manitoba RST is told apart from BC PST at the same 7% ==');
{
  const r = parseReceiptText(['STORE', recent(2), 'Subtotal 100.00', 'GST 5.00', 'RST 7.00', 'Total 112.00'].join('\n'));
  ok('province MB', r.tax_group === 'MB', r.tax_group);
}

console.log('\n== change and cash lines are not mistaken for the total ==');
{
  const r = parseReceiptText([
    'DEPANNEUR DU COIN', recent(1),
    'SOUS-TOTAL   8.70', 'TPS 0.44', 'TVQ 0.87',
    'TOTAL       10.01', 'COMPTANT    20.00', 'MONNAIE      9.99'
  ].join('\n'));
  ok('total is the total, not the cash tendered', r.total === 10.01, r.total);
}

console.log('\n== a tip is separated from the total ==');
{
  const r = parseReceiptText([
    'BISTRO', recent(1), 'SOUS-TOTAL 40.00', 'TPS 2.00', 'TVQ 3.99',
    'POURBOIRE 9.00', 'TOTAL 54.99'
  ].join('\n'));
  ok('tip captured', r.tip === 9.00, r.tip);
  ok('total includes the tip', r.total === 54.99, r.total);
  ok('still confident despite the tip', r.confidence === 'high', r.confidence);
}

console.log('\n== an unreadable receipt says so instead of inventing ==');
{
  const r = parseReceiptText('~~~ blurry ~~~\nnothing here');
  ok('returns nothing at all', r === null, r);
  const r2 = parseReceiptText(['SHOP', recent(1), 'ITEM 12.00', 'TOTAL 12.00'].join('\n'));
  ok('no tax line -> not high confidence', r2.confidence !== 'high', r2.confidence);
  ok('and says why', /tax/i.test(r2.note || ''), r2.note);
  ok('province left blank rather than guessed', r2.tax_group === '', r2.tax_group);
}

console.log('\n== a PDF, which Google returns run together on one line ==');
{
  /* Verbatim from a real Drive conversion of a PDF receipt: no newlines at
     all. Splitting on lines gave SOUS-TOTAL the last figure on the line and
     lost the tax entirely, which is what the token walk exists to fix. */
  const r = parseReceiptText('SOUS-TOTAL 24.00 TPS 1.20 TVQ 2.39 TOTAL 27.59 ');
  ok('subtotal', r.subtotal === 24.00, r.subtotal);
  ok('TPS', r.federal_tax === 1.20, r.federal_tax);
  ok('TVQ', r.provincial_tax === 2.39, r.provincial_tax);
  ok('total', r.total === 27.59, r.total);
  ok('province QC', r.tax_group === 'QC', r.tax_group);
  ok('confident, because the maths closes', r.confidence === 'high', r.confidence);
}

console.log('\n== a stranded label cannot reach down the receipt ==');
{
  /* The registration number is stripped, leaving a bare TPS and TVQ with no
     amount of their own. Neither may claim the price of a menu item. */
  const r = parseReceiptText([
    'CHEZ ASHTON',
    'TPS 123456789 RT0001',
    'TVQ 1234567890 TQ0001',
    '2 Poutine italienne      21.00',
    'SOUS-TOTAL               24.00',
    'TPS                       1.20',
    'TVQ                       2.39',
    'TOTAL                    27.59'
  ].join('\n'));
  ok('TPS is the tax, not the poutine', r.federal_tax === 1.20, r.federal_tax);
  ok('TVQ is the tax, not the poutine', r.provincial_tax === 2.39, r.provincial_tax);
  ok('registration numbers still read', r.federal_tax_number === '123456789 RT0001', r.federal_tax_number);
}

console.log('\n== a dotted date is not money ==');
{
  ok('23.08.2026 is not $23.08', amountsIn('Date 23.08.2026').length === 0, amountsIn('Date 23.08.2026'));
  ok('but 23.08 alone still is', amountsIn('TOTAL 23.08')[0] === 23.08, amountsIn('TOTAL 23.08'));
}

console.log('\n== a bilingual till does not move the receipt to Quebec ==');
{
  /* "TPS" appears on bilingual receipts countrywide. Only TVQ and QST name
     a tax that exists nowhere but Quebec. */
  const on = parseReceiptText(['CANADIAN TIRE','Ottawa ON','Subtotal 54.98','GST/TPS/HST 13% 7.15','TOTAL 62.13'].join('\n'));
  ok('bilingual Ontario stays Ontario', on.tax_group === 'ON', on.tax_group);

  const qc = parseReceiptText(['SOUS-TOTAL 24.00','TPS 1.20','TVQ 2.39','TOTAL 27.59'].join('\n'));
  ok('TVQ still means Quebec', qc.tax_group === 'QC', qc.tax_group);

  const lone = parseReceiptText(['DEP','TPS 1.20','TOTAL 27.59'].join('\n'));
  ok('TPS standing alone is still Quebec', lone.tax_group === 'QC', lone.tax_group);

  const ab = parseReceiptText(['SHOP','Calgary AB','Subtotal 100.00','GST/TPS 5.00','TOTAL 105.00'].join('\n'));
  ok('a bilingual Alberta till is not Quebec', ab.tax_group === '', ab.tax_group);

  const hst = parseReceiptText(['SHOP','Subtotal 100.00','HST 15.00','TOTAL 115.00'].join('\n'));
  ok('15% HST stays unknown', hst.tax_group === '', hst.tax_group);
}

console.log('\n== a subtotal we worked out ourselves proves nothing ==');
{
  /* Deriving subtotal = total - tax makes the balance check true by
     construction. A tax line misread as 99.00 on a $62 receipt used to come
     back "high" with a subtotal of -36.87 and no warning at all. */
  const bad = parseReceiptText(['SHOP','TPS 99.00','TOTAL 62.13'].join('\n'));
  ok('total is kept', bad.total === 62.13, bad.total);
  ok('the impossible subtotal is dropped', bad.subtotal === null, bad.subtotal);
  ok('the misread tax is dropped with it', bad.federal_tax === null, bad.federal_tax);
  ok('not reported as confident', bad.confidence !== 'high', bad.confidence);
  ok('and says to check it', !!bad.note, bad.note);

  const derived = parseReceiptText(['SHOP','TPS 3.00','TOTAL 63.00'].join('\n'));
  ok('a plausible derived subtotal is still offered', derived.subtotal === 60.00, derived.subtotal);
  ok('but never claims high confidence', derived.confidence !== 'high', derived.confidence);
  ok('and explains why', /subtotal/i.test(derived.note || ''), derived.note);

  const printed = parseReceiptText(['SHOP','SOUS-TOTAL 24.00','TPS 1.20','TVQ 2.39','TOTAL 27.59'].join('\n'));
  ok('a printed subtotal that checks out is high', printed.confidence === 'high', printed.confidence);
}

console.log('\n== money handed over is not the amount spent ==');
{
  /* No TOTAL label at all, so the largest amount wins — it must not be the
     twenty handed across the counter. */
  const c = parseReceiptText(['DEP DU COIN','ITEM 8.70','COMPTANT 20.00','MONNAIE 11.30'].join('\n'));
  ok('total is the purchase', c.total === 8.70, c.total);

  const e = parseReceiptText(['SHOP','ITEM 8.70','CASH 20.00','CHANGE 11.30'].join('\n'));
  ok('and in English too', e.total === 8.70, e.total);
}

console.log('\n== dates ==');
ok('ISO', findDate('Date: ' + recent(2)) === recent(2));
ok('day-first numeric', findDate(dmy(4)) === recent(4), findDate(dmy(4)));
ok('a future date is rejected', findDate('2099-01-01') === null, findDate('2099-01-01'));
ok('an ancient date is rejected', findDate('1999-05-05') === null);
{
  /* Built from today so these keep passing as the clock moves; a hardcoded
     year eventually falls outside plausibleDate's three-year window. */
  const FR = ['JANV','FEV','MARS','AVR','MAI','JUIN','JUIL','AOUT','SEPT','OCT','NOV','DEC'];
  const EN = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const t = new Date(today); t.setDate(t.getDate() - 6);
  const d = t.getDate(), mo = t.getMonth(), y = t.getFullYear();
  const want = recent(6);
  ok('textual French month', findDate(d + ' ' + FR[mo] + ' ' + y) === want, findDate(d + ' ' + FR[mo] + ' ' + y));
  ok('textual English month', findDate(EN[mo] + ' ' + d + ', ' + y) === want, findDate(EN[mo] + ' ' + d + ', ' + y));
}

console.log('\n== 15% HST is left blank because three provinces share it ==');
{
  const r = parseReceiptText(['SHOP', recent(1), 'Subtotal 100.00', 'HST 15.00', 'Total 115.00'].join('\n'));
  ok('no province guessed', r.tax_group === '', r.tax_group);
  ok('but the tax is still read', r.federal_tax === 15.00, r.federal_tax);
}

console.log('\n' + (fail ? 'FAILED ' + fail : 'all ' + pass + ' passed'));
process.exit(fail ? 1 : 0);
