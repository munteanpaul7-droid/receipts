/* Cloudflare Worker — reads a receipt photo with Claude and returns fields.
 *
 * Why this exists: the app is a static site, so anything it ships is public.
 * An Anthropic API key is a real secret, unlike the OAuth client ID. This
 * Worker holds the key server-side; the phone only ever talks to this URL.
 *
 * Deploy: Cloudflare dashboard -> Workers -> Create -> paste this file.
 * Then Settings -> Variables -> add a SECRET named ANTHROPIC_API_KEY.
 * Never put the key in this file — a secret in source is a leaked secret.
 */

const ALLOWED_ORIGINS = [
  'https://munteanpaul7-droid.github.io'
];

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
    date:       { type: ['string','null'], description: 'Purchase date as YYYY-MM-DD. Resolve 2-digit years and DD/MM vs MM/DD from context.' },
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
    note:       { type: ['string','null'], description: 'One short sentence only if something needs checking by hand. Otherwise null.' }
  },
  required: ['merchant','date','total','subtotal','federal_tax','provincial_tax',
             'tax_group','category','federal_tax_number','provincial_tax_number',
             'tip','confidence','note']
};

const SYSTEM = [
  'You read photographs of retail receipts and return their fields.',
  '',
  'Rules:',
  '- Report only what is printed. Never invent a value to fill a field; use null.',
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
  '  fields null, and say so in note.'
].join('\n');

function cors(origin) {
  const ok = ALLOWED_ORIGINS.indexOf(origin) >= 0;
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== 'POST') return json({ error: 'POST an image to this URL.' }, 405, origin);

    /* The browser enforces CORS, but a non-browser client ignores it, so the
       origin is checked here too. This is what keeps the key from becoming a
       free Claude endpoint for anyone who finds the URL. */
    if (origin && ALLOWED_ORIGINS.indexOf(origin) < 0) {
      return json({ error: 'Origin not allowed.' }, 403, origin);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: 'Worker is missing the ANTHROPIC_API_KEY secret.' }, 500, origin);
    }

    let body;
    try { body = await request.json(); }
    catch (e) { return json({ error: 'Body must be JSON.' }, 400, origin); }

    const data = body && body.image;
    const mediaType = (body && body.mediaType) || 'image/jpeg';
    if (!data || typeof data !== 'string') return json({ error: 'Missing image.' }, 400, origin);
    if (['image/jpeg','image/png','image/webp','image/gif'].indexOf(mediaType) < 0) {
      return json({ error: 'Unsupported image type.' }, 400, origin);
    }
    /* base64 inflates by ~4/3; this caps the request near 5 MB of pixels. */
    if (data.length > 7000000) return json({ error: 'Image too large.' }, 413, origin);

    const payload = {
      model: 'claude-opus-5',
      max_tokens: 8000,
      system: SYSTEM,
      output_config: { effort: 'low' },
      fallbacks: 'default',
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
          { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
          { type: 'text', text: 'Read this receipt and report its fields.' }
        ]
      }]
    };

    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'server-side-fallback-2026-07-01'
        },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      return json({ error: 'Could not reach the Claude API.' }, 502, origin);
    }

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      /* Surface the status so the phone can say something useful, but never
         echo request headers or the key. */
      return json({ error: 'Claude API ' + res.status, detail }, res.status === 429 ? 429 : 502, origin);
    }

    const msg = await res.json();

    if (msg.stop_reason === 'refusal') {
      return json({ error: 'The request was declined.' }, 422, origin);
    }

    const block = (msg.content || []).filter((b) => b.type === 'tool_use' && b.name === 'report_receipt')[0];
    if (!block) return json({ error: 'No fields came back. Try a clearer photo.' }, 502, origin);

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
