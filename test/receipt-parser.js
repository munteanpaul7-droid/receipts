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

console.log('\n== dates ==');
ok('ISO', findDate('Date: ' + recent(2)) === recent(2));
ok('day-first numeric', findDate(dmy(4)) === recent(4), findDate(dmy(4)));
ok('a future date is rejected', findDate('2099-01-01') === null, findDate('2099-01-01'));
ok('an ancient date is rejected', findDate('1999-05-05') === null);
ok('textual French month', /^\d{4}-\d{2}-\d{2}$/.test(String(findDate('23 AOUT 2026'))), findDate('23 AOUT 2026'));
ok('textual English month', /^\d{4}-\d{2}-\d{2}$/.test(String(findDate('AUG 23, 2026'))), findDate('AUG 23, 2026'));

console.log('\n== 15% HST is left blank because three provinces share it ==');
{
  const r = parseReceiptText(['SHOP', recent(1), 'Subtotal 100.00', 'HST 15.00', 'Total 115.00'].join('\n'));
  ok('no province guessed', r.tax_group === '', r.tax_group);
  ok('but the tax is still read', r.federal_tax === 15.00, r.federal_tax);
}

console.log('\n' + (fail ? 'FAILED ' + fail : 'all ' + pass + ' passed'));
process.exit(fail ? 1 : 0);
