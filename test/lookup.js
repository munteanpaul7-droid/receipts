/* Looking a business up by name. The thing that matters most here is that
   nothing reaches the network unless it was asked for — the free source is a
   third party, and the Google one costs money. */
const { freshEnv } = require('./harness');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };

const OSM = { features: [
  { properties: { name: 'Restaurant Chez Ashton', housenumber: '830', street: 'Boulevard Charest Est',
                  city: 'Québec', state: 'Quebec', postcode: 'G1K 3J7' } },
  { properties: { name: 'Restaurant Chez Ashton', housenumber: '54', street: 'Rue du Pont', city: 'Québec' } },
  { properties: { street: 'Rue Sans Nom', city: 'Québec' } }
] };

const GOOG = { places: [
  { displayName: { text: 'Restaurant Chez Ashton' }, formattedAddress: '830 Bd Charest E, Québec, QC G1K 3J7',
    nationalPhoneNumber: '(418) 522-3449' }
] };

function env(mode, reply, status) {
  const c = freshEnv();
  if (mode) c._ls.setItem('rc_cfg_lookup', JSON.stringify(mode));
  c.calls = [];
  c.fetch = (url, o) => {
    c.calls.push({ url: String(url), opts: o || {} });
    if (status && status !== 200) return Promise.resolve({ ok: false, status, json: () => Promise.resolve({}) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(reply) });
  };
  return c;
}

(async () => {
console.log('\n== off means off: nobody is contacted ==');
{
  const c = env(null, OSM);
  const r = await c.lookupPlaces('chez ashton');
  ok('no results', r.length === 0, r);
  ok('and no request at all', c.calls.length === 0, c.calls);
}

console.log('\n== OpenStreetMap, free and keyless ==');
{
  const c = env('osm', OSM);
  const r = await c.lookupPlaces('chez ashton');
  ok('a name and an address come back', r[0].name === 'Restaurant Chez Ashton', r[0]);
  ok('the address is assembled', r[0].address === '830 Boulevard Charest Est, Québec, Quebec, G1K 3J7', r[0].address);
  ok('no phone from this source', r[0].phone === '', r[0].phone);
  ok('a street with no business on it is dropped', r.length === 2, r.map((p) => p.name));
  ok('and is not offered under the road name', r.every((p) => p.name !== 'Rue Sans Nom'), r.map((p) => p.name));
  /* Two branches of the same chain are two answers; the address tells them
     apart, so only an exact repeat would be a duplicate. */
  ok('both branches survive', r[0].address !== r[1].address, r.map((p) => p.address));
  ok('no API key is sent', !/key/i.test(c.calls[0].url), c.calls[0].url);
  ok('the search is biased to Canada', /bbox=/.test(c.calls[0].url), c.calls[0].url);
}

console.log('\n== Google Places, when a key is set ==');
{
  const c = env('google', GOOG);
  c._ls.setItem('rc_cfg_placesKey', JSON.stringify('AIzaTEST'));
  const r = await c.lookupPlaces('chez ashton');
  ok('name', r[0].name === 'Restaurant Chez Ashton', r[0]);
  ok('address', /830 Bd Charest/.test(r[0].address), r[0].address);
  ok('and a phone, which OSM cannot give', r[0].phone === '(418) 522-3449', r[0].phone);
  ok('the key travels in a header, not the URL', c.calls[0].opts.headers['X-Goog-Api-Key'] === 'AIzaTEST');
  /* Asking for three fields keeps this in the cheapest tier Google bills. */
  const mask = c.calls[0].opts.headers['X-Goog-FieldMask'];
  ok('only the three fields we use are requested', mask.split(',').length === 3, mask);
  ok('and the search is scoped to Canada', /"regionCode":"CA"/.test(c.calls[0].opts.body), c.calls[0].opts.body);
}

console.log('\n== Google without a key never calls Google ==');
{
  const c = env('google', GOOG);
  let err = null;
  try { await c.lookupPlaces('chez ashton'); } catch (e) { err = e.message; }
  ok('it refuses', err === 'no-key', err);
  ok('and nothing was sent', c.calls.length === 0, c.calls);
}

console.log('\n== a refused key says so, rather than looking broken ==');
{
  const c = env('google', {}, 403);
  c._ls.setItem('rc_cfg_placesKey', JSON.stringify('AIzaBAD'));
  let err = null;
  try { await c.lookupPlaces('chez ashton'); } catch (e) { err = e.message; }
  ok('403 is a key problem', err === 'bad-key', err);
}

console.log('\n== Settings shows the key box only for Google ==');
{
  const c = freshEnv();
  c.paintLookup();
  ok('off by default', c.lookupMode() === 'off', c.lookupMode());
  ok('no key box', /hide/.test(c._els.googleOnly.className), c._els.googleOnly.className);
  ok('and the hint says nothing is sent', /nothing is sent/i.test(c._els.lookupHint.textContent), c._els.lookupHint.textContent);

  c._ls.setItem('rc_cfg_lookup', JSON.stringify('osm'));
  c.paintLookup();
  ok('OSM needs no key box', /hide/.test(c._els.googleOnly.className), c._els.googleOnly.className);
  ok('and the hint is honest about coverage', /only as good as/i.test(c._els.lookupHint.textContent), c._els.lookupHint.textContent);
  ok('and says it is better at addresses', /addresses/i.test(c._els.lookupHint.textContent), c._els.lookupHint.textContent);

  c._ls.setItem('rc_cfg_lookup', JSON.stringify('google'));
  c.paintLookup();
  ok('Google shows the key box', !/hide/.test(c._els.googleOnly.className), c._els.googleOnly.className);
  ok('and warns about the billing account', /billing account/i.test(c._els.lookupHint.textContent), c._els.lookupHint.textContent);
}

console.log('\n== typing an address gets addresses, not businesses ==');
{
  const c = env('osm', OSM);
  const r = await c.lookupAddresses('830 charest');
  ok('the address leads', r[0].address === '830 Boulevard Charest Est, Québec, Quebec, G1K 3J7', r[0]);
  ok('the business name comes along for context', r[0].name === 'Restaurant Chez Ashton', r[0].name);
  ok('a place with no street is not an address', r.every((p) => p.address), r);
  ok('identical addresses collapse', new Set(r.map((p) => p.address)).size === r.length, r.map((p) => p.address));
}

console.log('\n== address lookup respects the same switch ==');
{
  const off = env(null, OSM);
  const r = await off.lookupAddresses('830 charest');
  ok('off returns nothing', r.length === 0, r);
  ok('and contacts nobody', off.calls.length === 0, off.calls);

  const g = env('google', GOOG);
  let err = null;
  try { await g.lookupAddresses('830 charest'); } catch (e) { err = e.message; }
  ok('Google without a key still refuses', err === 'no-key', err);
  ok('and sends nothing', g.calls.length === 0, g.calls);
}

console.log('\n' + (fail ? 'FAILED ' + fail : 'all ' + pass + ' passed'));
process.exit(fail ? 1 : 0);
})();
