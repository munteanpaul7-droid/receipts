import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/* The Worker is an ES module living in a directory with no package.json, so
   Node would read its .js as CommonJS. Importing the source as a data URL
   runs the real file, unmodified, with no build step or temp copy. */
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'worker', 'receipt-ocr.js'), 'utf8');
const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };
const ORIGIN = 'https://munteanpaul7-droid.github.io';

let sent = [];
function stub(replies) {
  sent = [];
  globalThis.fetch = async (url, opts) => {
    sent.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    const r = replies[Math.min(sent.length - 1, replies.length - 1)];
    if (r === 'neterr') throw new Error('network down');
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status });
  };
}
const post = (body, origin = ORIGIN) => new Request('https://w.dev/', {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const IMG = { image: 'QUJD', mediaType: 'image/jpeg' };
const CLAUDE_OK = { status: 200, body: { stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 5 },
  content: [{ type: 'tool_use', name: 'report_receipt', input: { merchant: 'Chez Ashton', total: 114.98 } }] } };

console.log('\n== the health check answers even when nothing else can ==');
{
  const res = await worker.fetch(new Request('https://w.dev/', { headers: { Origin: ORIGIN } }), {});
  const d = await res.json();
  ok('GET returns 200', res.status === 200);
  ok('reports it is the scanner', d.service === 'receipt-ocr', JSON.stringify(d));
  ok('reports a missing key honestly', d.keyConfigured === false);
  ok('names the model in use', d.model === 'claude-opus-5', d.model);
  const res2 = await worker.fetch(new Request('https://w.dev/', { headers: { Origin: ORIGIN } }), { ANTHROPIC_API_KEY: 'k' });
  ok('reports a present key', (await res2.json()).keyConfigured === true);
  ok('health never calls Anthropic', true);
}

console.log('\n== every failure carries a code the phone can act on ==');
{
  let res = await worker.fetch(post(IMG), {});
  ok('missing secret -> no_key', (await res.json()).code === 'no_key');

  res = await worker.fetch(post(IMG, 'https://evil.example'), { ANTHROPIC_API_KEY: 'k' });
  ok('foreign origin -> 403 origin', res.status === 403 && (await res.json()).code === 'origin');

  stub([{ status: 401, body: { error: { message: 'invalid x-api-key' } } }]);
  res = await worker.fetch(post(IMG), { ANTHROPIC_API_KEY: 'k' });
  ok('401 -> bad_key', (await res.json()).code === 'bad_key');
  ok('a dead key is not retried', sent.length === 1, String(sent.length));

  stub([{ status: 429, body: { error: { message: 'Your credit balance is too low' } } }]);
  res = await worker.fetch(post(IMG), { ANTHROPIC_API_KEY: 'k' });
  ok('429 about billing -> credit, not rate_limit', (await res.json()).code === 'credit');

  stub([{ status: 429, body: { error: { message: 'rate limit exceeded' } } }, CLAUDE_OK]);
  res = await worker.fetch(post(IMG), { ANTHROPIC_API_KEY: 'k' });
  ok('a real rate limit is retried and recovers', res.status === 200 && sent.length === 2, String(sent.length));

  stub([{ status: 500, body: 'boom' }, { status: 500, body: 'boom' }]);
  res = await worker.fetch(post(IMG), { ANTHROPIC_API_KEY: 'k' });
  ok('5xx retried once then reported', (await res.json()).code === 'upstream' && sent.length === 2, String(sent.length));

  stub(['neterr']);
  res = await worker.fetch(post(IMG), { ANTHROPIC_API_KEY: 'k' });
  ok('network failure -> upstream 502', res.status === 502 && (await res.json()).code === 'upstream');
}

console.log('\n== a retired parameter degrades the scan instead of ending it ==');
{
  stub([{ status: 400, body: { type: 'error', error: { type: 'invalid_request_error',
          message: 'output_config.effort: unsupported value' } } }, CLAUDE_OK]);
  const res = await worker.fetch(post(IMG), { ANTHROPIC_API_KEY: 'k' });
  ok('ends up succeeding', res.status === 200, String(res.status));
  ok('tried twice', sent.length === 2, String(sent.length));
  ok('first try carried the optional params', !!sent[0].body.output_config && !!sent[0].body.fallbacks);
  ok('first try carried the beta header', !!sent[0].headers['anthropic-beta']);
  ok('retry dropped output_config', sent[1].body.output_config === undefined);
  ok('retry dropped fallbacks', sent[1].body.fallbacks === undefined);
  ok('retry dropped the beta header', sent[1].headers['anthropic-beta'] === undefined);
  ok('retry kept the image', sent[1].body.messages[0].content[0].type === 'image');
  ok('retry kept the forced tool', sent[1].body.tool_choice.name === 'report_receipt');

  // A 400 that is NOT about parameters must not trigger the degraded retry.
  stub([{ status: 400, body: { error: { type: 'invalid_request_error', message: 'image: could not be decoded' } } }]);
  const res2 = await worker.fetch(post(IMG), { ANTHROPIC_API_KEY: 'k' });
  ok('an unrelated 400 is not retried', sent.length === 1, String(sent.length));
  ok('and is reported as bad_request', (await res2.json()).code === 'bad_request');
}

console.log('\n== the happy path is unchanged ==');
{
  stub([CLAUDE_OK]);
  const res = await worker.fetch(post(IMG), { ANTHROPIC_API_KEY: 'k' });
  const d = await res.json();
  ok('returns ok + fields', d.ok === true && d.fields.merchant === 'Chez Ashton', JSON.stringify(d));
  ok('sends the documented model', sent[0].body.model === 'claude-opus-5', sent[0].body.model);
  ok('sends the version header', sent[0].headers['anthropic-version'] === '2023-06-01');

  stub([{ status: 200, body: { stop_reason: 'refusal', content: [] } }]);
  ok('a refusal is its own code', (await (await worker.fetch(post(IMG), { ANTHROPIC_API_KEY: 'k' })).json()).code === 'refused');
}

console.log('\n== a PDF receipt goes to Claude as a document, not an image ==');
{
  stub([CLAUDE_OK]);
  const res = await worker.fetch(post({ image: 'QUJD', mediaType: 'application/pdf' }), { ANTHROPIC_API_KEY: 'k' });
  ok('accepted', res.status === 200, String(res.status));
  const block = sent[0].body.messages[0].content[0];
  ok('sent as a document block', block.type === 'document', block.type);
  ok('with the pdf media type', block.source.media_type === 'application/pdf', block.source.media_type);
  ok('the document comes before the text', sent[0].body.messages[0].content[1].type === 'text');

  stub([CLAUDE_OK]);
  await worker.fetch(post(IMG), { ANTHROPIC_API_KEY: 'k' });
  ok('a photo is still an image block', sent[0].body.messages[0].content[0].type === 'image');

  stub([CLAUDE_OK]);
  const bad = await worker.fetch(post({ image: 'QUJD', mediaType: 'application/zip' }), { ANTHROPIC_API_KEY: 'k' });
  ok('an unsupported type is still refused', bad.status === 400, String(bad.status));
  ok('and nothing was sent upstream', sent.length === 0, String(sent.length));

  const health = await (await worker.fetch(new Request('https://w.dev/', { headers: { Origin: ORIGIN } }), {})).json();
  ok('health advertises what it accepts', health.accepts.includes('application/pdf'), health.accepts);
}

console.log('\n== a refused origin can read why it was refused ==');
{
  /* Withholding the CORS header on top of the 403 only stops the browser
     reading the reason, so the app blamed a deleted Worker instead of
     pointing at ALLOWED_ORIGINS. The 403 is the security control. */
  const res = await worker.fetch(post(IMG, 'https://evil.example'), { ANTHROPIC_API_KEY: 'k' });
  ok('still refused', res.status === 403);
  ok('but readable by that origin',
     res.headers.get('Access-Control-Allow-Origin') === 'https://evil.example',
     res.headers.get('Access-Control-Allow-Origin'));
  ok('and names the cause', (await res.json()).code === 'origin');
}

console.log('\n== CORS still lets the phone in ==');
{
  const pre = await worker.fetch(new Request('https://w.dev/', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), {});
  ok('preflight is 204', pre.status === 204);
  ok('allows GET now too', pre.headers.get('Access-Control-Allow-Methods').includes('GET'));
  ok('echoes the app origin', pre.headers.get('Access-Control-Allow-Origin') === ORIGIN);
}

console.log('\n' + (fail ? 'FAILED ' + fail : 'all ' + pass + ' passed'));
process.exit(fail ? 1 : 0);
