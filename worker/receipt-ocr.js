/* Cloudflare Worker — reads a receipt photo with Claude and returns fields.
 *
 * Why this exists: the app is a static site, so anything it ships is public.
 * An Anthropic API key is a real secret, unlike the OAuth client ID. This
 * Worker holds the key server-side; the phone only ever talks to this URL.
 *
 * Deploy: Cloudflare dashboard -> Workers -> Create -> paste this file.
 * Then Settings -> Variables -> add a SECRET named ANTHROPIC_API_KEY.
 * Never put the key in this file — a secret in source is a leaked secret.
 *
 * Two habits here exist because the phone is often far from a laptop:
 *   - GET returns a health report, so "Test the scanner" can tell "the Worker
 *     is gone" apart from "the Worker is up but Claude is refusing us".
 *   - Every error carries a short `code`. The app turns codes into a sentence
 *     telling you which knob to turn; a bare 502 tells you nothing.
 */

const VERSION = '2026-08-24';

const ALLOWED_ORIGINS = [
  'https://munteanpaul7-droid.github.io'
];

const MODEL = 'claude-opus-5';

/* Photos from the camera, and the PDFs that emailed receipts arrive as. */
const ACCEPTED = ['image/jpeg','image/png','image/webp','image/gif','application/pdf'];

/* Kept in step with TAX_GROUPS and CATEGORIES in app.js. */
const TAX_CODES = ['QC','ON','AB','BC','MB','NB','NL','NS','NT','NU','PE','SK','YT',''];
const CATEGORIES = [
  'Restaurant','Gas / Fuel','Groceries / Food','Furniture','Office supplies',
  'Travel / Hotel','Vehicle / Maintenance','Utilities / Telecom',
  'Professional services','Software / Subscriptions','Tools / Equipment',
  'Advertising / Marketing','Other'
];

/* strict:true demands additionalProperties:false and every key in required,
   so "unknown" is expressed as null rather than by omitting the field. */
const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    merchant:   { type: ['string','null'], description: 'Business name as printed. No address or slogan.' },
    address:    { type: ['string','null'], description: 'Street address of the business, on one line: street, city, province, postal code. Null if not printed.' },
    phone:      { type: ['string','null'], description: 'Business telephone number as printed. Null if not printed, and never a fax or an order number.' },
    date:       { type: ['string','null'], description: 'Purchase date as YYYY-MM-DD. Resolve 2-digit years and DD/MM vs MM/DD from context.' },
    time:       { type: ['string','null'], description: 'Time of the transaction as HH:MM on a 24-hour clock. Convert from am/pm. Null if not printed.' },
    total:      { type: ['number','null'], description: 'Final amount actually paid, after tax and tip.' },
    subtotal:   { type: ['number','null'], description: 'Amount before any tax.' },
    federal_tax:    { type: ['number','null'], description: 'GST, HST or TPS in dollars. HST goes here, not in provincial_tax.' },
    provincial_tax: { type: ['number','null'], description: 'PST, QST, TVQ or RST in dollars. Null in HST and GST-only provinces.' },
    tax_group:  { type: 'string', enum: TAX_CODES, description: 'Province two-letter code, inferred from the address, tax labels or currency. Empty string if genuinely unclear.' },
    category:   { type: 'string', enum: CATEGORIES, description: 'Best-fitting expense category.' },
    federal_tax_number:    { type: ['string','null'], description: 'Vendor GST/HST/TPS registration number if printed.' },
    provincial_tax_number: { type: ['string','null'], description: 'Vendor QST/TVQ/PST registration number if printed.' },
    tip:        { type: ['number','null'], description: 'Tip or gratuity in dollars if shown separately.' },
    confidence: { type: 'string', enum: ['high','medium','low'], description: 'low if the image is blurry, cropped, or not a receipt.' },
    note:       { type: ['string','null'], description: 'One short sentence only if something needs checking by hand. Otherwise null.' },
    terms:      { type: ['string','null'], description: 'Plain-language summary, two sentences at most, of any return policy, warranty or condition printed on the receipt. Null if none is printed.' },
    return_days:{ type: ['number','null'], description: 'Number of days allowed to return or exchange, if the receipt states one. Where several are given, the shortest. Null if not stated.' },
    offer_summary: { type: ['string','null'], description: 'One sentence describing a promotion, contest or survey ONLY when something can be won. A survey that merely asks for feedback is not one: return null for it.' },
    offer_url:  { type: ['string','null'], description: 'The web address for that offer, exactly as printed. Null unless offer_summary is set.' }
  },
  required: ['merchant','address','phone','date','time','terms','return_days','offer_summary','offer_url','total','subtotal','federal_tax','provincial_tax',
             'tax_group','category','federal_tax_number','provincial_tax_number',
             'tip','confidence','note']
};

const SYSTEM = [
  'You read retail receipts and return their fields. Most arrive as a',
  'photograph; some are a PDF, which is usually an emailed or printed receipt',
  'and cleaner to read. A PDF holding several receipts is unusual — if you get',
  'one, report the first and say so in note.',
  '',
  'Rules:',
  '- Report only what is printed. Never invent a value to fill a field; use null.',
  '- The business name, its address and its telephone number are usually the',
  '  first few lines. Put the name in merchant and nothing else — no street,',
  '  no slogan. Give the address as one line. A number labelled fax, order or',
  '  invoice is not the phone number.',
  '- Amounts are plain numbers: 114.98, not "$114.98" and not "114,98".',
  '- The total is what was actually charged. On a restaurant bill that means',
  '  the figure after any tip, not the pre-tip subtotal.',
  '- Canadian tax lines: GST/TPS and HST are federal_tax. QST/TVQ, PST and RST',
  '  are provincial_tax. HST is a single combined tax — put it in federal_tax',
  '  and leave provincial_tax null.',
  '- Infer the province from the printed address, the tax labels used, or the',
  '  registration number format. TVQ or TPS means Quebec. A lone HST line at',
  '  13% means Ontario. Use an empty string when you truly cannot tell.',
  '- A receipt photographed at an angle or partly in shadow is still readable —',
  '  do your best, and set confidence to medium or low to say how sure you are.',
  '- If the image is not a receipt at all, set confidence to low, leave the',
  '  fields null, and say so in note.',
  '- Read the small print under the total. Summarise a return policy,',
  '  warranty or condition in plain language, two sentences at most, and give',
  '  the number of days allowed to bring it back. Where several windows are',
  '  printed, report the shortest, since that is the one that bites.',
  '- Report a promotion, contest or survey ONLY when something can actually',
  '  be won. A shop asking how their service was is not worth reporting:',
  '  leave offer_summary null for it. Say in one sentence what is on offer',
  '  and what it takes to enter.'
].join('\n');

/* The origin is echoed back even when it is refused. The 403 is what keeps
   the key private; withholding the CORS header on top of it only stops the
   browser reading the reason, so the app reported "the Worker may have been
   deleted" when the real answer was one line of ALLOWED_ORIGINS away. */
function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, cors(origin))
  });
}

function fail(code, error, status, origin, extra) {
  return json(Object.assign({ ok: false, code, error }, extra || {}), status, origin);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* An HTTP status from Anthropic, turned into something the phone can act on.
   The split that matters to a user is "wait" versus "go fix something". */
function classify(status, detail) {
  const d = String(detail || '').toLowerCase();
  if (status === 401 || status === 403) return { code: 'bad_key', retry: false };
  if (status === 402) return { code: 'credit', retry: false };
  if (status === 429) {
    /* Anthropic uses 429 both for "too fast" and for "out of credit". They
       need opposite advice, so read the body rather than the status alone. */
    if (d.indexOf('credit') >= 0 || d.indexOf('billing') >= 0) return { code: 'credit', retry: false };
    return { code: 'rate_limit', retry: true };
  }
  if (status === 400) return { code: 'bad_request', retry: false };
  if (status === 404) return { code: 'bad_model', retry: false };
  if (status === 413) return { code: 'too_big', retry: false };
  if (status >= 500) return { code: 'upstream', retry: true };
  return { code: 'upstream', retry: false };
}

/* Signals that the API rejected one of the optional parameters rather than the
   request itself — the shape most likely to rot as the API moves on. When this
   happens we retry once with the plainest request that can still do the job,
   so a parameter being retired degrades the scan instead of ending it. */
function looksLikeParamDrift(detail) {
  const d = String(detail || '').toLowerCase();
  if (d.indexOf('unexpected') < 0 && d.indexOf('unsupported') < 0 &&
      d.indexOf('unrecognized') < 0 && d.indexOf('not supported') < 0 &&
      d.indexOf('invalid_request_error') < 0) return false;
  return d.indexOf('fallback') >= 0 || d.indexOf('output_config') >= 0 ||
         d.indexOf('effort') >= 0 || d.indexOf('beta') >= 0 ||
         d.indexOf('thinking') >= 0 || d.indexOf('strict') >= 0;
}

/* A photo arrives as an image block, an emailed receipt as a document one.
   Claude reads a PDF natively — no conversion or OCR step in between — so
   the only difference is which block the bytes are wrapped in. */
function sourceBlock(mediaType, data) {
  if (mediaType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: mediaType, data } };
  }
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

function buildPayload(mediaType, data, plain) {
  const payload = {
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM,
    tools: [{
      name: 'report_receipt',
      description: 'Report the fields read from the receipt image.',
      strict: true,
      input_schema: RECEIPT_SCHEMA
    }],
    tool_choice: { type: 'tool', name: 'report_receipt' },
    messages: [{
      role: 'user',
      content: [
        /* The document or image goes first; Claude reads it better that way. */
        sourceBlock(mediaType, data),
        { type: 'text', text: 'Read this receipt and report its fields.' }
      ]
    }]
  };
  /* Reading a receipt is not a reasoning problem, so effort stays low; the
     fallback keeps a safety refusal from turning into a dead end. Both are
     dropped in the plain retry — neither is needed to read a receipt. */
  if (!plain) {
    payload.output_config = { effort: 'low' };
    payload.fallbacks = 'default';
  }
  return payload;
}

function headers(key, plain) {
  const h = {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01'
  };
  if (!plain) h['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  return h;
}

/* One call, with a single retry on the two failures that are worth waiting
   out. More than one retry would just make the phone sit there longer. */
async function callClaude(key, mediaType, data, plain) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: headers(key, plain),
        body: JSON.stringify(buildPayload(mediaType, data, plain))
      });
    } catch (e) {
      if (attempt === 0) { await sleep(700); continue; }
      return { netError: true };
    }
    if (res.ok) return { res };

    const detail = (await res.text()).slice(0, 400);
    const kind = classify(res.status, detail);
    if (kind.retry && attempt === 0) { await sleep(res.status === 429 ? 1500 : 700); continue; }
    return { status: res.status, detail, kind };
  }
  return { netError: true };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    /* The browser enforces CORS, but a non-browser client ignores it, so the
       origin is checked here too. This is what keeps the key from becoming a
       free Claude endpoint for anyone who finds the URL. */
    if (origin && ALLOWED_ORIGINS.indexOf(origin) < 0) {
      return fail('origin', 'This Worker does not accept requests from ' + origin + '.', 403, origin);
    }

    /* A reachable GET is the proof that the Worker itself is alive. It costs
       nothing and never touches Anthropic, so it stays honest even when the
       key is the broken part. */
    if (request.method === 'GET' || request.method === 'HEAD') {
      return json({
        ok: true,
        service: 'receipt-ocr',
        version: VERSION,
        model: MODEL,
        accepts: ACCEPTED,
        keyConfigured: !!env.ANTHROPIC_API_KEY
      }, 200, origin);
    }

    if (request.method !== 'POST') {
      return fail('method', 'POST an image to this URL.', 405, origin);
    }

    if (!env.ANTHROPIC_API_KEY) {
      return fail('no_key',
        'The Worker has no ANTHROPIC_API_KEY secret. Add it in the Cloudflare dashboard under Settings, Variables.',
        500, origin);
    }

    let body;
    try { body = await request.json(); }
    catch (e) { return fail('bad_body', 'Body must be JSON.', 400, origin); }

    const data = body && body.image;
    const mediaType = (body && body.mediaType) || 'image/jpeg';
    if (!data || typeof data !== 'string') return fail('bad_body', 'Missing image.', 400, origin);
    if (ACCEPTED.indexOf(mediaType) < 0) {
      return fail('bad_body', 'Unsupported file type.', 400, origin);
    }
    /* base64 inflates by ~4/3; this caps the request near 5 MB of pixels. */
    if (data.length > 7000000) {
      return fail('too_big',
        mediaType === 'application/pdf'
          ? 'That PDF is too large to read.'
          : 'That photo is too large. Lower Image size in Settings.',
        413, origin);
    }

    let out = await callClaude(env.ANTHROPIC_API_KEY, mediaType, data, false);

    /* The API turned down one of the optional parameters. Try again without
       them before giving up — a retired parameter should cost quality, not
       the whole feature. */
    if (out.kind && out.kind.code === 'bad_request' && looksLikeParamDrift(out.detail)) {
      out = await callClaude(env.ANTHROPIC_API_KEY, mediaType, data, true);
    }

    if (out.netError) {
      return fail('upstream', 'Could not reach the Claude API.', 502, origin);
    }
    if (!out.res) {
      /* Surface the status so the phone can say something useful, but never
         echo request headers or the key. */
      const status = out.kind.code === 'rate_limit' ? 429 : (out.status === 402 ? 402 : 502);
      return fail(out.kind.code, 'Claude API ' + out.status, status, origin, { detail: out.detail });
    }

    const msg = await out.res.json();

    if (msg.stop_reason === 'refusal') {
      return fail('refused', 'Claude declined to read that image.', 422, origin);
    }

    const block = (msg.content || []).filter((b) => b.type === 'tool_use' && b.name === 'report_receipt')[0];
    if (!block) return fail('no_fields', 'No fields came back. Try a clearer photo.', 502, origin);

    return json({
      ok: true,
      fields: block.input,
      usage: {
        input_tokens: msg.usage && msg.usage.input_tokens,
        output_tokens: msg.usage && msg.usage.output_tokens
      }
    }, 200, origin);
  }
};
