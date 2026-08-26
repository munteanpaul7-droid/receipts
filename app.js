/* Receipts -> Google Drive
   A single-user PWA. No server: the phone talks straight to the Drive API.
   Scope used is drive.file, so the app can only ever touch the folder and
   files it created itself. It cannot read the rest of the Drive.       */

'use strict';

/* ---------------------------------------------------------------- config */

const CATEGORIES = [
  'Restaurant',
  'Gas / Fuel',
  'Groceries / Food',
  'Furniture',
  'Office supplies',
  'Travel / Hotel',
  'Vehicle / Maintenance',
  'Utilities / Telecom',
  'Professional services',
  'Software / Subscriptions',
  'Tools / Equipment',
  'Advertising / Marketing',
  'Other'
];

/* Canadian sales tax by province. Every one of these is charged on the
   pre-tax subtotal — none of them compound on each other, including QST,
   which stopped stacking on GST back in 2013 — so one formula covers the
   country: total = subtotal x (1 + r1 + r2).
   HST provinces have a single combined tax, so they leave r2 at zero and
   the second field hides itself.
   Rates verified to May 2026. Nova Scotia dropped 15 -> 14 in April 2025;
   if any rate moves, edit it here or use the Custom group.              */
const TAX_GROUPS = [
  { code: 'QC', name: 'Quebec — TPS 5% + TVQ 9.975%',        t1: 'TPS', r1: 5,  t2: 'TVQ', r2: 9.975 },
  { code: 'ON', name: 'Ontario — HST 13%',                   t1: 'HST', r1: 13, t2: '',    r2: 0 },
  { code: 'AB', name: 'Alberta — GST 5%',                    t1: 'GST', r1: 5,  t2: '',    r2: 0 },
  { code: 'BC', name: 'British Columbia — GST 5% + PST 7%',  t1: 'GST', r1: 5,  t2: 'PST', r2: 7 },
  { code: 'MB', name: 'Manitoba — GST 5% + RST 7%',          t1: 'GST', r1: 5,  t2: 'RST', r2: 7 },
  { code: 'NB', name: 'New Brunswick — HST 15%',             t1: 'HST', r1: 15, t2: '',    r2: 0 },
  { code: 'NL', name: 'Newfoundland and Labrador — HST 15%', t1: 'HST', r1: 15, t2: '',    r2: 0 },
  { code: 'NS', name: 'Nova Scotia — HST 14%',               t1: 'HST', r1: 14, t2: '',    r2: 0 },
  { code: 'NT', name: 'Northwest Territories — GST 5%',      t1: 'GST', r1: 5,  t2: '',    r2: 0 },
  { code: 'NU', name: 'Nunavut — GST 5%',                    t1: 'GST', r1: 5,  t2: '',    r2: 0 },
  { code: 'PE', name: 'Prince Edward Island — HST 15%',      t1: 'HST', r1: 15, t2: '',    r2: 0 },
  { code: 'SK', name: 'Saskatchewan — GST 5% + PST 6%',      t1: 'GST', r1: 5,  t2: 'PST', r2: 6 },
  { code: 'YT', name: 'Yukon — GST 5%',                      t1: 'GST', r1: 5,  t2: '',    r2: 0 },
  { code: 'XX', name: 'Custom rates (set in Settings)',      t1: 'Tax 1', r1: null, t2: 'Tax 2', r2: null }
];

function taxGroup(code) {
  return TAX_GROUPS.filter((g) => g.code === code)[0] || TAX_GROUPS[0];
}

/* Custom borrows its rates and keeps generic labels; everything else is
   fixed by statute. */
function taxRates(code) {
  const g = taxGroup(code);
  if (g.code === 'XX') return { t1: g.t1, r1: num(cfg('tpsRate')), t2: g.t2, r2: num(cfg('tvqRate')) };
  return { t1: g.t1, r1: g.r1, t2: g.t2, r2: g.r2 };
}

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

const CSV_NAME = 'receipts-index.csv';
/* Keep every header comma-free — appendToIndex splits the stored header on
   commas to spot an out-of-date layout. */
const CSV_HEADER = ['Date','Time','Merchant','Address','Phone','Category','Purpose','Tax group','Subtotal',
                    'Federal tax (GST/HST/TPS)','Provincial tax (PST/QST/TVQ)','Total',
                    'Federal tax no.','Provincial tax no.','File','Drive link','Saved at'];

/* This app's OAuth client, created under munteanpaul7@gmail.com. A web client
   ID is public by design — it travels in the URL of every sign-in — and there
   is no client secret in this flow, so it is safe to keep here. Overridable
   per-device from Settings. */
const DEFAULTS = {
  clientId: '74591076439-0hkmtsuqouhn0av8qeeov1u248vtesh5.apps.googleusercontent.com',
  root: 'receipts',
  struct: 'ym',
  taxGroup: 'QC',
  aiUrl: '',
  /* Google Drive reads receipts for nothing and needs no setting up, so it
     is what a fresh install uses. See readerMode() for the one exception. */
  reader: 'drive',
  autoScan: '1',
  tpsRate: '5',
  tvqRate: '9.975',
  maxPx: '1600'
};

/* Bumped whenever app.js, index.html or styles.css change. Shown in Settings
   so "did the update actually land" is a question you can answer from the
   phone, and used by the service worker to name its cache. */
const APP_VERSION = '2026-08-24.6';

/* ------------------------------------------------------------- utilities */

const $ = (id) => document.getElementById(id);

/* For elements added after the app first shipped. During an update a phone can
   briefly hold a new app.js beside an older index.html; reaching for a missing
   element would throw and take the whole startup with it. This turns that into
   a no-op, which is the difference between one dead button and a dead app. */
const NULL_EL = { value: '', textContent: '', className: 'hide', disabled: false,
                  addEventListener() {}, appendChild() {} };
const $opt = (id) => $(id) || NULL_EL;

const S = {
  get(k, d) {
    try { const v = localStorage.getItem('rc_' + k); return v === null ? d : JSON.parse(v); }
    catch (e) { return d; }
  },
  set(k, v) { try { localStorage.setItem('rc_' + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { localStorage.removeItem('rc_' + k); }
};

function cfg(k) { const v = S.get('cfg_' + k, null); return (v === null || v === '') ? DEFAULTS[k] : v; }
function setCfg(k, v) { S.set('cfg_' + k, v); }

/* Amounts turn up in several shapes on a Quebec keyboard: 1,234.56 and
   1.234,56 and 114,98 all mean what they look like. Rules, in order:
   when both separators appear the rightmost one is the decimal point;
   a lone comma is a thousands mark only when exactly three digits follow
   it, so 1,234 is a thousand but 114,98 is not; a repeated separator is
   always a thousands mark; and a lone dot always stays a decimal point,
   which is what keeps rates like 9.975 intact.                          */
function num(v) {
  if (v === null || v === undefined) return 0;
  let s = String(v).trim();
  const neg = s.charAt(0) === '-';
  s = s.replace(/[^0-9.,]/g, '');
  if (!s) return 0;

  const lastDot = s.lastIndexOf('.');
  const lastCom = s.lastIndexOf(',');
  let dec = -1;

  if (lastDot >= 0 && lastCom >= 0) {
    dec = Math.max(lastDot, lastCom);
  } else if (lastCom >= 0) {
    if (s.indexOf(',') === lastCom && !/,\d{3}$/.test(s)) dec = lastCom;
  } else if (lastDot >= 0) {
    if (s.indexOf('.') === lastDot) dec = lastDot;
  }

  const whole = (dec < 0 ? s : s.slice(0, dec)).replace(/[.,]/g, '');
  const frac = dec < 0 ? '' : s.slice(dec + 1).replace(/[.,]/g, '');
  const n = parseFloat((neg ? '-' : '') + (whole || '0') + (frac ? '.' + frac : ''));
  return isFinite(n) ? n : 0;
}
function money(n) { return '$' + (Math.round(n * 100) / 100).toFixed(2); }
function fixed(n) { return (Math.round(n * 100) / 100).toFixed(2); }
function todayISO() {
  const d = new Date(), p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|#]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'receipt';
}
function qEsc(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

let toastTimer = null;
function toast(msg, kind) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast' + (kind ? ' ' + kind : ''); }, 4200);
}

/* --------------------------------------------------------- Google OAuth  */

let tokenClient = null;
let accessToken = S.get('tok', null);
let tokenExp = S.get('tokExp', 0);

function connected() { return !!accessToken && Date.now() < tokenExp - 60000; }

function initTokenClient() {
  const id = cfg('clientId');
  if (!id || !window.google || !google.accounts || !google.accounts.oauth2) return false;
  if (tokenClient && tokenClient.__id === id) return true;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: id,
    scope: 'https://www.googleapis.com/auth/drive.file',
    callback: () => {}
  });
  tokenClient.__id = id;
  return true;
}

/* Must be invoked from inside a user gesture the first time, otherwise iOS
   Safari blocks the popup. `silent` reuses the existing Google session.   */
function requestToken(silent) {
  return new Promise((resolve, reject) => {
    if (!initTokenClient()) return reject(new Error('no-client-id'));
    tokenClient.callback = (r) => {
      if (r.error) return reject(new Error(r.error));
      accessToken = r.access_token;
      tokenExp = Date.now() + (Number(r.expires_in || 3600) * 1000);
      S.set('tok', accessToken); S.set('tokExp', tokenExp); S.set('granted', true);
      paintStatus();
      resolve(accessToken);
    };
    tokenClient.error_callback = (e) => reject(new Error((e && e.type) || 'popup-failed'));
    try {
      tokenClient.requestAccessToken({ prompt: silent ? '' : (S.get('granted', false) ? '' : 'consent') });
    } catch (e) { reject(e); }
  });
}

async function ensureToken() {
  if (connected()) return accessToken;
  return requestToken(true);
}

/* --- popup-free sign-in -------------------------------------------------
   iOS home-screen apps sometimes push window.open out to Safari, which
   breaks the popup handshake. This whole-page redirect always works.     */

/* Google matches redirect URIs exactly, so this has to land on one fixed
   string no matter how the app was opened. A home-screen launch starts at
   the manifest's start_url and a tapped link usually ends in a bare slash;
   folding a trailing index.html away makes both produce the directory form
   that is registered in the Cloud console.                               */
function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html?$/i, '');
}

function startRedirectAuth() {
  const id = cfg('clientId');
  if (!id) { toast('Paste your OAuth Client ID first.', 'bad'); return; }
  const state = uid();
  S.set('authState', state);
  const p = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: 'https://www.googleapis.com/auth/drive.file',
    include_granted_scopes: 'true',
    state: state,
    prompt: 'consent'
  });
  location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}

/* Picks up #access_token=... when Google sends us back. */
function consumeRedirectAuth() {
  if (!location.hash || location.hash.indexOf('access_token') < 0) return false;
  const h = new URLSearchParams(location.hash.slice(1));
  const tok = h.get('access_token');
  const ok = h.get('state') && h.get('state') === S.get('authState', null);
  history.replaceState(null, '', redirectUri());
  S.del('authState');
  if (!tok || !ok) { toast('Sign-in response could not be verified.', 'bad'); return false; }
  accessToken = tok;
  tokenExp = Date.now() + (Number(h.get('expires_in') || 3600) * 1000);
  S.set('tok', accessToken); S.set('tokExp', tokenExp); S.set('granted', true);
  return true;
}

function signOut() {
  if (accessToken && window.google && google.accounts && google.accounts.oauth2) {
    try { google.accounts.oauth2.revoke(accessToken, () => {}); } catch (e) {}
  }
  accessToken = null; tokenExp = 0;
  S.del('tok'); S.del('tokExp'); S.del('granted'); S.del('rootId');
  paintStatus();
  toast('Signed out of Google Drive.');
}

/* ----------------------------------------------------------- Drive API   */

async function drive(path, opts) {
  opts = opts || {};
  const headers = Object.assign({ Authorization: 'Bearer ' + accessToken }, opts.headers || {});
  const res = await fetch('https://www.googleapis.com/drive/v3' + path, Object.assign({}, opts, { headers }));
  if (res.status === 401) { accessToken = null; tokenExp = 0; throw new Error('auth-expired'); }
  if (!res.ok) throw new Error('Drive ' + res.status + ': ' + (await res.text()).slice(0, 300));
  return res;
}

async function driveJSON(path, opts) { return (await drive(path, opts)).json(); }

async function findChild(name, parentId, folderOnly) {
  let q = "name='" + qEsc(name) + "' and trashed=false";
  if (folderOnly) q += " and mimeType='application/vnd.google-apps.folder'";
  if (parentId) q += " and '" + qEsc(parentId) + "' in parents";
  const r = await driveJSON('/files?spaces=drive&fields=files(id,name)&pageSize=10&q=' + encodeURIComponent(q));
  return (r.files && r.files[0]) ? r.files[0].id : null;
}

async function makeFolder(name, parentId) {
  const body = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) body.parents = [parentId];
  const r = await driveJSON('/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.id;
}

async function ensureFolder(name, parentId) {
  return (await findChild(name, parentId, true)) || makeFolder(name, parentId);
}

/* Root folder id is cached so we do not search on every save. */
async function rootFolderId() {
  const cached = S.get('rootId', null);
  if (cached) {
    try {
      const f = await driveJSON('/files/' + cached + '?fields=id,trashed,name');
      if (!f.trashed) return f.id;
    } catch (e) { /* fall through and recreate */ }
  }
  const id = await ensureFolder(cfg('root'), null);
  S.set('rootId', id);
  return id;
}

async function folderForDate(rootId, iso) {
  const struct = cfg('struct');
  if (struct === 'flat') return rootId;
  const y = iso.slice(0, 4), m = iso.slice(5, 7);
  const yId = await ensureFolder(y, rootId);
  if (struct === 'y') return yId;
  return ensureFolder(y + '-' + m + ' ' + MONTHS[parseInt(m, 10) - 1], yId);
}

async function uploadFile(blob, name, parentId, description, props) {
  const meta = { name, parents: [parentId] };
  if (description) meta.description = description;
  if (props) meta.appProperties = props;
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  form.append('file', blob, name);
  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
    { method: 'POST', headers: { Authorization: 'Bearer ' + accessToken }, body: form }
  );
  if (res.status === 401) { accessToken = null; tokenExp = 0; throw new Error('auth-expired'); }
  if (!res.ok) throw new Error('Upload ' + res.status + ': ' + (await res.text()).slice(0, 300));
  return res.json();
}

function csvCell(v) {
  const s = String(v === null || v === undefined ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvRow(arr) { return arr.map(csvCell).join(',') + '\r\n'; }

async function renameFile(id, name) {
  return driveJSON('/files/' + id + '?fields=id', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
}

async function appendToIndex(rootId, row) {
  let id = await findChild(CSV_NAME, rootId, false);
  let body;
  if (id) {
    const cur = await (await drive('/files/' + id + '?alt=media')).text();
    /* An index written by an older build has fewer columns. Appending to it
       would silently shift every value one cell left, so retire it under a
       new name and start a clean one instead. */
    const head = (cur.split(/\r?\n/)[0] || '').replace(/^﻿/, '');
    const cols = head ? head.split(',').length : 0;
    if (cols && cols !== CSV_HEADER.length) {
      await renameFile(id, 'receipts-index (older layout).csv');
      id = null;
    } else {
      body = (cur.endsWith('\n') || cur === '' ? cur : cur + '\r\n') + csvRow(row);
    }
  }
  if (!id) {
    body = '﻿' + csvRow(CSV_HEADER) + csvRow(row);
    const created = await uploadFile(new Blob([body], { type: 'text/csv' }), CSV_NAME, rootId);
    return created.id;
  }
  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files/' + id + '?uploadType=media&fields=id',
    {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'text/csv' },
      body: new Blob([body], { type: 'text/csv' })
    }
  );
  if (!res.ok) throw new Error('Index ' + res.status);
  return id;
}

/* -------------------------------------------------- offline upload queue */

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('receipts-db', 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('queue')) r.result.createObjectStore('queue', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function qOp(mode, fn) {
  return idb().then((db) => new Promise((res, rej) => {
    const tx = db.transaction('queue', mode);
    const out = fn(tx.objectStore('queue'));
    tx.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
    tx.onerror = () => rej(tx.error);
  }));
}
const qPut = (item) => qOp('readwrite', (s) => s.put(item));
const qDel = (id) => qOp('readwrite', (s) => s.delete(id));
const qAll = () => qOp('readonly', (s) => s.getAll());

/* ------------------------------------------------------------ image prep */

/* Canvas work on a phone is where this app is most likely to stall: a very
   large photo, a browser under memory pressure, and toBlob simply never
   calls back. Every exit path below settles the promise, and a watchdog
   settles it anyway if none of them fire — a receipt uploaded at full size
   beats an app frozen on "Processing photo".                              */
function shrinkImage(file, maxPx) {
  return new Promise((resolve) => {
    if (file.type === 'application/pdf') return resolve({ blob: file, ext: 'pdf', thumb: '' });

    let settled = false;
    const url = URL.createObjectURL(file);
    const done = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      try { URL.revokeObjectURL(url); } catch (e) {}
      resolve(out);
    };
    const watchdog = setTimeout(() => done({ blob: file, ext: file.type === 'image/png' ? 'png' : 'jpg', thumb: '' }), 20000);

    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);

        const t = document.createElement('canvas');
        const ts = Math.min(1, 120 / Math.max(w, h));
        t.width = Math.max(1, Math.round(w * ts)); t.height = Math.max(1, Math.round(h * ts));
        t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
        const thumb = t.toDataURL('image/jpeg', 0.6);

        c.toBlob((blob) => done({ blob: blob || file, ext: 'jpg', thumb }), 'image/jpeg', 0.82);
      } catch (e) {
        /* Out of memory, or a canvas the browser refuses to size. Upload the
           original rather than losing the receipt. */
        done({ blob: file, ext: 'jpg', thumb: '' });
      }
    };
    img.onerror = () => done({ blob: file, ext: 'jpg', thumb: '' });
    img.src = url;
  });
}

/* ------------------------------------------------------------ app state  */

let pending = null;   // { blob, ext, thumb } for the photo currently attached
let prevUrl = '';     // object URL backing the preview image, revoked on clear
let catTouched = false; // once you pick a category yourself, the scan leaves it alone

/* ---------------------------------------------------------------- render */

function paintStatus() {
  const ok = connected();
  $('dot').className = 'dot' + (ok ? ' on' : '');
  $('sWho').value = ok ? 'Connected to Google Drive'
    : (cfg('clientId') ? 'Client ID saved. Tap Connect Drive.' : 'Not connected');
  $('setupWarn').className = 'banner' + (cfg('clientId') ? ' hide' : '');
  const rid = S.get('rootId', null);
  $('folderInfo').textContent = rid
    ? 'Drive folder ready: "' + cfg('root') + '" (the app only sees files it created).'
    : 'The folder "' + cfg('root') + '" is created automatically on your first save.';
  refreshPending();
}

async function refreshPending() {
  let n = 0;
  try { n = (await qAll()).length; } catch (e) {}
  $('pendN').textContent = n;
  $('pendBtn').className = 'chip' + (n ? '' : ' hide');
}

function getHistory() { return S.get('hist', []); }
function pushHistory(rec) {
  const h = getHistory();
  h.unshift(rec);
  S.set('hist', h.slice(0, 250));
}
function updateHistory(id, patch) {
  const h = getHistory();
  const i = h.findIndex((x) => x.id === id);
  if (i >= 0) { Object.assign(h[i], patch); S.set('hist', h); }
}

function paintHistory() {
  const h = getHistory();
  const el = $('histCard');
  if (!h.length) { el.innerHTML = '<div class="empty">No receipts yet.</div>'; return; }
  el.innerHTML = h.slice(0, 80).map((r) => {
    const mark = r.status === 'saved' ? '' : (r.status === 'pending' ? ' &middot; waiting to upload' : ' &middot; not uploaded');
    const th = r.thumb ? '<img src="' + r.thumb + '" alt="">' : '&#128441;';
    const name = (r.name || 'Receipt').replace(/</g, '&lt;');
    const sub = r.date + ' &middot; ' + (r.cat || '') + mark;
    const inner = '<div class="th">' + th + '</div>' +
      '<div class="m"><b>' + name + '</b><span>' + sub + '</span></div>' +
      '<div class="amt">' + money(r.total) + '<small>tx ' + fixed(r.tps + r.tvq) + '</small></div>';
    return r.link
      ? '<a class="it" href="' + r.link + '" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">' + inner + '</a>'
      : '<div class="it">' + inner + '</div>';
  }).join('');
}

function paintMerchants() {
  const v = S.get('vendors', {});
  const keys = Object.keys(v);
  $('merchants').innerHTML = keys.map((k) => '<option value="' + (v[k].label || k).replace(/"/g, '') + '">').join('');

  /* Every address this phone has already filed, offered as you type. Between
     this and the phone's own saved addresses, typing one out in full is rare
     — and neither costs anything or needs an account. */
  const seen = {};
  keys.forEach((k) => { if (v[k].addr) seen[v[k].addr] = true; });
  $opt('addresses').innerHTML = Object.keys(seen)
    .map((a) => '<option value="' + a.replace(/"/g, '') + '">').join('');
}

/* Relabels the tax fields for the chosen province and folds away the second
   one in HST and GST-only places, where a second tax does not exist. */
function applyTaxGroup(code, clearAmounts) {
  const rt = taxRates(code);
  const single = !rt.t2;

  $('lblT1').textContent = rt.t1 + ' ($)';
  $('lblT1No').textContent = rt.t1 + ' number';
  $('wrapT2').className = single ? 'hide' : '';
  $('wrapT2No').className = single ? 'f hide' : 'f';
  if (!single) {
    $('lblT2').textContent = rt.t2 + ' ($)';
    $('lblT2No').textContent = rt.t2 + ' number';
  }
  $('chkLbl').textContent = single
    ? 'Subtotal + ' + rt.t1
    : 'Subtotal + ' + rt.t1 + ' + ' + rt.t2;

  /* A hidden second field must not keep a stale amount, or it would quietly
     ride along into the total check and the spreadsheet. */
  if (single) $('fTvq').value = '0.00';
  if (clearAmounts) { $('fTps').value = ''; if (!single) $('fTvq').value = ''; }
  updateSums();
}

function updateSums() {
  const total = num($('fTotal').value), tps = num($('fTps').value), tvq = num($('fTvq').value);
  const sub = total - tps - tvq;
  $('sub').textContent = money(sub);
  const chk = sub + tps + tvq;
  $('chk').textContent = money(chk);
  $('chk').className = Math.abs(chk - total) > 0.005 ? 'warnv' : '';
}

/* ------------------------------------------------------------- form flow */

/* Drops whatever is attached and releases its blob URL. */
function clearPreview() {
  if (prevUrl) { URL.revokeObjectURL(prevUrl); prevUrl = ''; }
  pending = null;
  $('prev').className = 'prev hide';
  $('prevImg').className = '';
  $('prevImg').removeAttribute('src');
  $('prevPdf').className = 'pdf hide';
  $('prevSz').className = 'sz';
  $('scanRow').className = 'scan hide';
}

function resetForm(keepDate) {
  if (!keepDate) $('fDate').value = todayISO();
  $('fTotal').value = ''; $('fName').value = ''; $('fPurpose').value = '';
  $('fAddr').value = ''; $('fPhone').value = ''; $('fTime').value = '';
  $('fTps').value = ''; $('fTvq').value = ''; $('fTpsNo').value = ''; $('fTvqNo').value = '';
  clearPreview();
  updateSums();
}

/* A PDF has no raster to show, and feeding one to an <img> only ever draws
   a broken-image icon, so it gets a named card instead. It still uploads
   exactly as picked.                                                     */
async function attach(file) {
  if (!file) return;
  const isPdf = file.type === 'application/pdf';
  toast(isPdf ? 'Attaching PDF...' : 'Processing photo...');

  let shot;
  try {
    shot = await shrinkImage(file, parseInt(cfg('maxPx'), 10));
  } catch (e) {
    /* shrinkImage is written not to reject, but if it ever does, the photo
       still has to reach Drive — attach the original untouched. */
    shot = { blob: file, ext: isPdf ? 'pdf' : 'jpg', thumb: '' };
  }

  clearPreview();
  pending = shot;
  const kb = (pending.blob.size / 1024).toFixed(0) + ' KB';

  if (pending.ext === 'pdf') {
    $('prevImg').className = 'hide';
    $('prevPdf').className = 'pdf';
    $('prevPdfName').textContent = file.name || 'document.pdf';
    $('prevPdfMeta').textContent = 'PDF · ' + kb + ' · uploaded as-is';
    $('prevSz').className = 'sz hide';
  } else {
    prevUrl = URL.createObjectURL(pending.blob);
    $('prevImg').src = prevUrl;
    $('prevSz').textContent = kb;
  }

  $('prev').className = 'prev';

  const mode = readerMode();
  const tooBig = isPdf && pending.blob.size > MAX_PDF_BYTES;
  const canRead = !tooBig && mode !== 'off' && (mode === 'drive' || !!cfg('aiUrl'));

  if (!canRead) {
    toast((isPdf ? 'PDF' : 'Photo') + ' attached. Fill in the details.', 'good');
  } else if (scannerOffline()) {
    /* The scanner failed its way out of the loop earlier. Say so once, in
       passing, and get out of the way of the form. */
    const h = scanHealth();
    setScan('', 'Scanner is off for now — ' + (h.msg || 'it stopped answering.') +
               ' Type the details in, or tap Read to try it again.');
  } else if (cfg('autoScan') === '1') {
    scanReceipt(false);
  } else {
    setScan('', 'Tap Read to fill the fields in for you.');
  }
}

/* ------------------------------------------------------- AI receipt scan

   The scanner is the only part of this app that depends on someone else's
   server staying up: a Cloudflare Worker holding an Anthropic key. Workers
   get deleted, keys get rotated, bills go unpaid. When that happens the
   receipts still have to get filed, so the rule throughout this section is
   that reading a receipt is a convenience and typing one is the product.
   Nothing below is allowed to block the form, and no failure is reported as
   a bare status code — every one of them names what broke and what to do.  */

/* Three failures in a row and the app stops asking on every photo; it goes
   quiet for a quarter of an hour and then tries again by itself. Without
   this, a Worker that has been deleted paints a red error over every single
   receipt you file, which is what makes a working app feel broken.        */
const SCAN_FAIL_LIMIT = 3;
const SCAN_COOLDOWN_MS = 15 * 60 * 1000;
const SCAN_TIMEOUT_MS = 45000;

function scanHealth() { return S.get('scanHealth', { fails: 0, until: 0, code: '', msg: '', fix: '' }); }

function scannerOffline() {
  const h = scanHealth();
  return h.fails >= SCAN_FAIL_LIMIT && Date.now() < h.until;
}

function noteScanOk() { S.set('scanHealth', { fails: 0, until: 0, code: '', msg: '', fix: '' }); }

function noteScanFail(info) {
  const fails = scanHealth().fails + 1;
  S.set('scanHealth', {
    fails,
    until: fails >= SCAN_FAIL_LIMIT ? Date.now() + SCAN_COOLDOWN_MS : 0,
    code: info.code, msg: info.msg, fix: info.fix
  });
}

/* Shows only the controls the chosen reader actually uses — a Worker URL
   box is noise to someone using the free one. */
function paintReaderMode() {
  const mode = readerMode();
  $opt('sReader').value = mode;
  $opt('aiOnly').className = 'f' + (mode === 'ai' ? '' : ' hide');
  $opt('aiTest').className = 'btn ghost' + (mode === 'ai' ? '' : ' hide');
  $opt('readerHint').textContent =
    mode === 'drive' ? 'Your photo goes to Google Drive, which reads the text at no charge, and the temporary copy is deleted straight away. Works on printed receipts; check the boxes before saving.'
  : mode === 'ai'    ? 'Claude reads the receipt properly — layout, French or English, which province. Needs an Anthropic account with credit, roughly a dollar or two a month.'
                     : 'Nothing is read for you. Photos still upload to Drive exactly as before.';
}

/* The Settings line that says where the scanner stands. It is the one place
   that states out loud what failed last time and which knob fixes it. */
function paintScannerState() {
  const el = $opt('aiState');
  const wake = $opt('aiWake');
  const h = scanHealth();

  const mode = readerMode();
  if (mode === 'off') {
    el.textContent = 'Reading is switched off. Every receipt gets typed in by hand.';
    wake.className = 'chip hide';
  } else if (mode === 'ai' && !cfg('aiUrl')) {
    el.textContent = 'Claude is selected but no scanner URL is set. Paste the Worker address above.';
    wake.className = 'chip hide';
  } else if (scannerOffline()) {
    const mins = Math.max(1, Math.round((h.until - Date.now()) / 60000));
    el.textContent = 'Paused after ' + h.fails + ' failures in a row. ' + h.msg + ' ' + h.fix +
      ' It tries again by itself in about ' + mins + ' minute' + (mins === 1 ? '' : 's') + '.';
    wake.className = 'chip';
  } else if (h.fails > 0) {
    el.textContent = 'Last read failed. ' + h.msg + ' ' + h.fix;
    wake.className = 'chip hide';
  } else if (mode === 'drive') {
    el.textContent = connected() || S.get('granted', false)
      ? 'Google Drive is reading your receipts. Free, and nothing to set up.'
      : 'Google Drive will read your receipts once you tap Connect Drive above.';
    wake.className = 'chip hide';
  } else {
    el.textContent = 'Claude is reading your receipts.';
    wake.className = 'chip hide';
  }
}

/* A hung request is worse than a failed one — it leaves the spinner turning
   with no way back — so every call to the scanner carries its own deadline. */
function fetchWithTimeout(url, opts, ms) {
  if (typeof AbortController === 'undefined') return fetch(url, opts);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return fetch(url, Object.assign({}, opts, { signal: ac.signal }))
    .finally(() => clearTimeout(timer));
}

/* What broke, and what to do about it. The Worker sends a short code for
   anything it can name; a status is only guessed from when it cannot. Every
   entry ends with a next step, because "scanner returned 502" tells the
   person holding the phone nothing they can act on.                        */
const SCAN_CAUSES = {
  no_key:      { msg: 'The scanner is running but has no Anthropic key.',
                 fix: 'Add ANTHROPIC_API_KEY as a secret on the Cloudflare Worker.' },
  bad_key:     { msg: 'Anthropic rejected the scanner\u2019s key.',
                 fix: 'Create a new API key and update the Worker\u2019s secret.' },
  credit:      { msg: 'The Anthropic account is out of credit.',
                 fix: 'Top it up — the scanner starts working again on its own.' },
  rate_limit:  { msg: 'Anthropic is rate-limiting the scanner.',
                 fix: 'Wait a minute, then tap Read.', transient: true },
  upstream:    { msg: 'Anthropic did not answer the scanner.',
                 fix: 'Usually passes by itself. Tap Read to try again.', transient: true },
  bad_model:   { msg: 'The scanner is asking for a Claude model that no longer exists.',
                 fix: 'Update MODEL in worker/receipt-ocr.js and redeploy the Worker.' },
  bad_request: { msg: 'Anthropic turned the request down as malformed.',
                 fix: 'The Worker is out of date. Redeploy worker/receipt-ocr.js.' },
  origin:      { msg: 'The scanner refuses requests from this address.',
                 fix: 'Add ' + location.origin + ' to ALLOWED_ORIGINS in the Worker.' },
  refused:     { msg: 'Claude declined to read that image.',
                 fix: 'Fill this one in by hand.' },
  no_fields:   { msg: 'Nothing came back for that photo.',
                 fix: 'Try a straighter, brighter photo — or type it in.' },
  too_big:     { msg: 'That file is too large for the scanner.',
                 fix: 'Lower Image size in Settings, or type this one in.' }
};

function explainScanFailure(status, data, netErr) {
  if (netErr) {
    return navigator.onLine
      ? { code: 'unreachable',
          msg: 'The scanner never answered. It may have been deleted, or its address changed.',
          fix: 'Check the Scanner URL in Settings, then tap Test the scanner.' }
      : { code: 'offline',
          msg: 'No connection, so the receipt cannot be read here.',
          fix: 'Type it in — saving works offline and uploads later.',
          transient: true };
  }

  const code = data && data.code;
  if (code && SCAN_CAUSES[code]) return Object.assign({ code }, SCAN_CAUSES[code]);

  /* No code came back, so this is something between us and the Worker
     rather than the Worker itself. */
  if (status === 401 || status === 403) {
    return Object.assign({ code: 'origin' }, SCAN_CAUSES.origin);
  }
  if (status === 404) {
    return { code: 'unreachable',
             msg: 'There is no scanner at that address.',
             fix: 'Check the Scanner URL in Settings.' };
  }
  if (status >= 500) {
    return { code: 'upstream',
             msg: 'The scanner failed on its side.',
             fix: 'Tap Read to try again, or type it in.', transient: true };
  }
  return { code: 'unknown',
           msg: (data && data.error) ? String(data.error).slice(0, 90) : 'The scanner returned ' + (status || 'nothing') + '.',
           fix: 'Type it in — that always works.' };
}

/* -------------------------------------------- reading a receipt for free

   Google Drive does optical character recognition at no charge: upload an
   image and ask for it back as a Google Doc, and the text comes out. The
   app is already signed in to Drive with permission to create files, so
   this costs nothing, needs no API key, and needs no setting up. The temp
   document is deleted the moment its text has been read.

   What comes back is the receipt as plain text, roughly in reading order
   and with the odd character mangled. Everything below is the business of
   turning that into fields, and all of it is written to fail softly: a
   value that cannot be read with confidence is left empty for you to type
   rather than guessed at.                                                */

/* Amounts as printed in Canada: 114.98, 114,98, 1,234.56, 1 234,56. The
   trailing guard keeps a tax rate like 9.975 from being read as 9.97, and
   the two alternatives keep 1234.56 from being read as 234.56. num()
   already understands every one of these shapes. */
const AMOUNT_RE = /(?:\d{1,3}(?:[  ,]\d{3})+|\d+)[.,]\d{2}(?![\d]|[.,]\d)/g;

function amountsIn(line) {
  const m = String(line).match(AMOUNT_RE);
  return m ? m.map(num) : [];
}

/* Receipts print the label on the left and the figure on the right, so on
   a line that names something, the number wanted is the last one. */
function lastAmount(line) {
  const a = amountsIn(line);
  return a.length ? a[a.length - 1] : null;
}

const RX = {
  subtotal: /\b(?:sous[\s\-]*total|sub[\s\-]*total|s\/?[\s\-]?total)\b/i,
  total:    /\b(?:grand\s+total|total|montant|amount\s+due|balance\s+due|[àa]\s+payer)\b/i,
  fed:      /\b(?:tps|gst|hst|tvh)\b/i,
  prov:     /\b(?:tvq|qst|pst|rst|tvp)\b/i,
  tip:      /\b(?:pourboire|gratuit[ée]?|gratuity|tip)\b/i,
  change:   /\b(?:monnaie|change|rendu|rendre)\b/i,
  cash:     /\b(?:comptant|cash|esp[èe]ces|tendered|re[çc]u\s+de)\b/i,
  /* Registration numbers, which must never be mistaken for money. */
  fedNo:    /\b(\d{9}\s*RT\s*\d{4})\b/i,
  provNo:   /\b(\d{10}\s*TQ\s*\d{4})\b/i
};

const MONTH_WORDS = {
  jan:1, janv:1, janvier:1, january:1,
  feb:2, febr:2, february:2, fev:2, 'fév':2, fevr:2, 'févr':2, fevrier:2, 'février':2,
  mar:3, mars:3, march:3,
  apr:4, april:4, avr:4, avril:4,
  may:5, mai:5,
  jun:6, june:6, juin:6,
  jul:7, july:7, juil:7, juillet:7,
  aug:8, august:8, aou:8, 'aoû':8, aout:8, 'août':8,
  sep:9, sept:9, september:9, septembre:9,
  oct:10, october:10, octobre:10,
  nov:11, november:11, novembre:11,
  dec:12, december:12, 'déc':12, decembre:12, 'décembre':12
};

function iso(y, m, d) {
  const p = (x) => String(x).padStart(2, '0');
  return y + '-' + p(m) + '-' + p(d);
}

/* A receipt is a record of something that already happened and is almost
   always recent, so a date in the future or from years back is a misread
   rather than a purchase. */
function plausibleDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  if (y < 100) y += y > 70 ? 1900 : 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  const now = Date.now();
  const age = now - dt.getTime();
  if (age < -36 * 3600 * 1000) return null;             // tomorrow or later
  if (age > 3 * 365 * 24 * 3600 * 1000) return null;    // more than three years old
  return { text: iso(y, m, d), at: dt.getTime() };
}

function monthNum(word) {
  const k = String(word).toLowerCase().replace(/\.$/, '');
  if (MONTH_WORDS[k]) return MONTH_WORDS[k];
  /* Fall back on the first three letters, which is how most receipts
     abbreviate and how OCR usually leaves an accented month. */
  return MONTH_WORDS[k.slice(0, 4)] || MONTH_WORDS[k.slice(0, 3)] || 0;
}

function findDate(text) {
  const found = [];

  /* Unambiguous first: a four-digit year pins the order. */
  let re = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/g, m;
  while ((m = re.exec(text))) {
    const d = plausibleDate(+m[1], +m[2], +m[3]);
    if (d) found.push(d);
  }

  /* 23 AOUT 2026, and AUG 23 2026. */
  re = /(\d{1,2})\s*[-/. ]\s*([A-Za-zÀ-ÿ]{3,10})\.?\s*[-/. ,]\s*(\d{2,4})/g;
  while ((m = re.exec(text))) {
    const mo = monthNum(m[2]);
    if (mo) { const d = plausibleDate(+m[3], mo, +m[1]); if (d) found.push(d); }
  }
  re = /([A-Za-zÀ-ÿ]{3,10})\.?\s*[-/. ]\s*(\d{1,2})\s*[-/. ,]\s*(\d{2,4})/g;
  while ((m = re.exec(text))) {
    const mo = monthNum(m[1]);
    if (mo) { const d = plausibleDate(+m[3], mo, +m[2]); if (d) found.push(d); }
  }

  /* All-numeric with a short year is genuinely ambiguous between the
     Canadian day-first and the American month-first. Where only one of
     them is a real, recent date, that settles it; where both are, the one
     nearer today wins, because that is what a receipt in your pocket is. */
  re = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/g;
  while ((m = re.exec(text))) {
    const a = +m[1], b = +m[2], y = +m[3];
    const dayFirst = plausibleDate(y, b, a);
    const monthFirst = plausibleDate(y, a, b);
    if (dayFirst && monthFirst) found.push(dayFirst.at >= monthFirst.at ? dayFirst : monthFirst);
    else if (dayFirst) found.push(dayFirst);
    else if (monthFirst) found.push(monthFirst);
  }

  if (!found.length) return null;
  /* Several dates on one receipt usually means a transaction date and a
     card expiry or a "valid until"; the purchase is the most recent one
     that is not in the future. */
  found.sort((x, y) => y.at - x.at);
  return found[0].text;
}

/* The time of purchase, as tills print it: 18:42, 18:42:15, 6:42 PM, and the
   French 18h42. Returned as HH:MM for the 24-hour <input type="time">.
   A colon or an h between the numbers is what makes this safe to look for —
   an amount uses a dot or a comma, and a phone number has neither. */
const TIME_RE = /\b(\d{1,2})\s*[:h]\s*([0-5]\d)(?:\s*[:.]\s*([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)?/ig;

function findTime(text) {
  let m;
  TIME_RE.lastIndex = 0;
  while ((m = TIME_RE.exec(text))) {
    let h = parseInt(m[1], 10);
    const min = m[2];
    const ampm = (m[4] || '').toLowerCase().replace(/\./g, '');
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    /* Without am/pm the hour must already be a real 24-hour one. A stray
       "Table 24:00" or a mangled number is not a time of day. */
    if (h > 23) continue;
    return String(h).padStart(2, '0') + ':' + min;
  }
  return null;
}

/* The shop name is nearly always the first real line. Skip the noise a
   till prints above it and anything that is mostly digits. */
const NAME_NOISE = /^(?:re[çc]u|receipt|facture|invoice|copie|copy|client|merchant|marchand|bienvenue|welcome|thank|merci|bon\s|tel|t[ée]l|fax|www\.|http|no\.?\s*\d|#\d|caisse|term|terminal|date|heure|time)/i;

/* Which line the shop name is on. The address is whatever sits directly
   beneath it, so the two searches share this. -1 when nothing qualifies. */
function merchantLine(lines) {
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const l = lines[i];
    const letters = (l.match(/[A-Za-zÀ-ÿ]/g) || []).length;
    const digits = (l.match(/\d/g) || []).length;
    if (letters < 3) continue;
    if (digits > letters) continue;
    if (NAME_NOISE.test(l)) continue;
    if (RX.fed.test(l) || RX.prov.test(l) || RX.total.test(l)) continue;
    return i;
  }
  return -1;
}

function findMerchant(lines, at) {
  if (at < 0) return null;
  /* Trim a trailing store or branch number, keep the name. */
  return lines[at].replace(/\s*[#(]?\s*(?:no|n[o°]|store|succ|mag)?\.?\s*\d{2,}\s*\)?\s*$/i, '').trim().slice(0, 60) || null;
}

/* A North American number, in the shapes a till prints. A label wins where
   there is one; otherwise punctuation is required, because a bare run of ten
   digits on a receipt is far more likely to be an invoice or a card number
   than somewhere you could ring. */
const PHONE_LABELLED = /(?:t[ée]l(?:[ée]phone)?|tel|phone|ph|fax|sans\s+frais|toll[\s-]?free)\s*[.:#]?\s*(\+?1[\s.\-]?)?(\(?\d{3}\)?[\s.\-]\s?\d{3}[\s.\-]\d{4}|\d{10})/i;
const PHONE_LOOSE = /(?:\+?1[\s.\-])?(?:\(\d{3}\)\s*|\d{3}[\s.\-])\d{3}[\s.\-]\d{4}/;

function tidyPhone(raw) {
  const d = String(raw).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (d.length !== 10) return null;
  return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
}

function findPhone(text) {
  const labelled = text.match(PHONE_LABELLED);
  if (labelled) {
    const t = tidyPhone(labelled[0].replace(/^[^0-9(+]*/, ''));
    if (t) return t;
  }
  const loose = text.match(PHONE_LOOSE);
  return loose ? tidyPhone(loose[0]) : null;
}

/* The address sits between the shop name and the first thing that costs
   money. Canadian receipts give it away with a street number, a province
   code or a postal code, and the lines run consecutively — so collecting
   stops at the first line that looks like none of those. */
const DATE_LINE = /^\s*\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\b/;
const POSTAL = /\b[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d\b/;
const STREET = /^\s*\d+\s*[A-Za-z]?[\s,.-]+\S/;
const PROVINCE = /\b(?:QC|ON|BC|AB|MB|SK|NS|NB|NL|PE|NT|NU|YT|Quebec|Qu[ée]bec|Ontario|Alberta|Manitoba|Saskatchewan)\b/i;

function findAddress(lines, at) {
  if (at < 0) return null;
  const out = [];
  for (let i = at + 1; i < Math.min(lines.length, at + 6); i++) {
    const l = lines[i];
    /* Anything priced, taxed or totalled means the header is over. */
    if (RX.fed.test(l) || RX.prov.test(l) || RX.total.test(l) || RX.subtotal.test(l)) break;
    if (amountsIn(l).length) break;
    /* The phone and the date have fields of their own. Skip past them rather
       than ending the address, and never absorb them into it — "2026-08-23"
       is a run of digits with separators, which is also what a street number
       looks like. */
    if (PHONE_LABELLED.test(l) || PHONE_LOOSE.test(l)) continue;
    if (DATE_LINE.test(l) || findDate(l)) continue;
    if (STREET.test(l) || POSTAL.test(l) || PROVINCE.test(l)) out.push(l.trim());
    else if (out.length) break;
  }
  if (!out.length) return null;
  return out.join(', ').replace(/\s{2,}/g, ' ').slice(0, 120);
}

/* Province from the tax lines. The labels alone settle Quebec and rule out
   the HST provinces; where two provinces share a label the rates separate
   them. Anything still ambiguous is left empty so your own default stands
   rather than being overwritten with a guess. */
function inferGroup(text, sub, fed, prov) {
  /* TVQ and QST name a tax that exists only in Quebec, so either settles it.
     TPS does not: a bilingual till anywhere in the country prints "GST/TPS",
     and an Ontario one prints "HST/TVH" beside it. Treating TPS as proof of
     Quebec filed every bilingual Ontario receipt under the wrong province. */
  if (/\b(?:tvq|qst)\b/i.test(text)) return 'QC';

  const near = (a, b) => a > 0 && Math.abs(a - b) <= 0.4;
  const fr = sub > 0 ? (fed / sub) * 100 : 0;
  const pr = sub > 0 ? (prov / sub) * 100 : 0;

  if (prov > 0) {
    if (near(fr, 5) && near(pr, 9.975)) return 'QC';
    if (near(fr, 5) && near(pr, 7)) return /\brst\b/i.test(text) ? 'MB' : 'BC';
    if (near(fr, 5) && near(pr, 6)) return 'SK';
    if (/\brst\b/i.test(text)) return 'MB';
    return '';
  }
  if (near(fr, 13)) return 'ON';
  if (near(fr, 14)) return 'NS';
  /* TPS with no GST beside it. A bilingual till anywhere prints both, so
     TPS standing alone is Quebec naming its own federal tax — provided no
     HST contradicts it. */
  if (/\btps\b/i.test(text) && !/\bgst\b/i.test(text) && !/\b(?:hst|tvh)\b/i.test(text)) return 'QC';
  /* 15% is New Brunswick, Newfoundland and PEI alike, and a lone 5% could
     be any of Alberta, NWT, Nunavut or Yukon. Neither is knowable. */
  return '';
}

/* Turns the OCR text into the same shape the Claude reader returns, so
   everything downstream — applyScan, the form, the history — is unchanged
   whichever reader produced it. */
/* One scanner over the whole receipt: group 1 is an amount, group 2 a label.
   Order inside the label list is load-bearing — "sous-total" and "grand
   total" must be offered before plain "total", or the engine would match the
   shorter word first and mistake a subtotal for the total. */
const AMOUNT_SRC = '(?:\\d{1,3}(?:[ \u00a0,]\\d{3})+|\\d+)[.,]\\d{2}(?![\\d]|[.,]\\d)';
const LABEL_SRC = [
  'sous[\\s\\-]*total', 'sub[\\s\\-]*total',
  'monnaie', 'rendu', 'comptant', 'esp[\u00e8e]ces', 'tendered', 'change', 'cash',
  'pourboire', 'gratuity', 'tip',
  'tps', 'gst', 'hst', 'tvh',
  'tvq', 'qst', 'pst', 'rst', 'tvp',
  'grand\\s+total', 'total', 'montant',
  'amount\\s+due', 'balance\\s+due', '[\u00e0a]\\s+payer'
].join('|');
const TOKEN_RE = new RegExp('(' + AMOUNT_SRC + ')|\\b(' + LABEL_SRC + ')\\b', 'gi');

/* How far past a label its amount may sit. Wide enough for a till padding a
   line out to the right margin. A claim also never crosses a line break: the
   figure belonging to a label is printed beside it, so a label left stranded
   with nothing of its own — the bare "TPS" beside a registration number,
   once that number is stripped — comes away empty rather than reaching down
   the receipt to take the price of a menu item. */
const LABEL_REACH = 40;

function labelKind(word) {
  const l = String(word).toLowerCase();
  if (/sous|sub/.test(l)) return 'subtotal';
  if (/monnaie|rendu|comptant|esp|tendered|change|cash/.test(l)) return 'skip';
  if (/pourboire|gratuity|tip/.test(l)) return 'tip';
  if (/tps|gst|hst|tvh/.test(l)) return 'fed';
  if (/tvq|qst|pst|rst|tvp/.test(l)) return 'prov';
  return 'total';
}

function parseReceiptText(text) {
  const clean = String(text || '').replace(/ /g, ' ');
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  /* Strip registration numbers before anything else looks at the text: they
     are long digit runs sitting right beside the words TPS and TVQ, and
     nothing good comes of letting later rules see them. */
  const body = clean.replace(RX.fedNo, ' ').replace(RX.provNo, ' ');

  let subtotal = null, total = null, fedTax = null, provTax = null, tip = null;
  const totalCandidates = [], allAmounts = [];

  /* Walk the receipt as a run of labels and amounts rather than splitting it
     into lines. A photographed receipt comes back line by line, but Google
     hands back a PDF with the whole thing run together on one line — and
     splitting that on newlines gives "SOUS-TOTAL" the last figure on the
     line instead of the one printed beside it. Reading it as a sequence is
     true of both: every label claims the next amount that follows it. */
  let claim = null, claimEnd = 0, m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(body))) {
    if (m[1] !== undefined) {
      const amt = num(m[1]);
      /* Money handed over and change given back are not amounts the receipt
         is for, so they must not survive into the largest-amount fallback —
         a $20 note tendered for an $8.70 purchase would become the total. */
      if (claim !== 'skip') allAmounts.push(amt);
      /* A label owns the figure printed next to it, across a gap of padding
         spaces at most. Without this a label left stranded with no amount of
         its own — the bare "TPS" beside a registration number, once that
         number is stripped — would reach down the receipt and claim the
         price of a menu item. */
      const gap = body.slice(claimEnd, m.index);
      if (gap.length > LABEL_REACH || gap.indexOf('\n') >= 0) claim = null;
      if (claim === 'subtotal') { if (subtotal === null) subtotal = amt; }
      else if (claim === 'tip') { if (tip === null) tip = amt; }
      else if (claim === 'fed') { if (fedTax === null) fedTax = amt; }
      else if (claim === 'prov') { if (provTax === null) provTax = amt; }
      else if (claim === 'total') totalCandidates.push(amt);
      /* 'skip' falls through deliberately: change and cash-tendered lines
         swallow their amount so it can never be taken for the total. */
      claim = null;
    } else {
      claim = labelKind(m[2]);
      claimEnd = m.index + m[2].length;
    }
  }

  /* Several places say TOTAL — the amount, the card total, the tendered
     amount. The real one is the largest, since every other total on a
     receipt is a part of it. */
  if (totalCandidates.length) total = Math.max.apply(null, totalCandidates);

  /* Nothing said "total" anywhere. The largest amount on the receipt is
     the next best guess, and is usually right. */
  if (total === null && allAmounts.length) total = Math.max.apply(null, allAmounts);
  if (!total || total <= 0) return null;

  /* Only a subtotal actually printed on the receipt can corroborate the tax.
     One worked out by subtracting the tax from the total makes the sum below
     add up by construction, which would report perfect confidence in figures
     nothing has checked. A tax line misread as 99.00 on a $62 receipt gave a
     subtotal of -36.87 and still came back green. */
  const subtotalPrinted = subtotal !== null;
  if (!subtotalPrinted && fedTax !== null) {
    const derived = total - fedTax - (provTax || 0);
    /* A negative subtotal means the tax was misread, not that the shop paid
       you. Keep the total, drop the tax, and say so. */
    if (derived > 0) subtotal = derived;
    else { fedTax = null; provTax = null; }
  }

  /* Does the arithmetic close? That single check is worth more than any
     amount of pattern matching for knowing whether to trust this. */
  const sum = (subtotal || 0) + (fedTax || 0) + (provTax || 0);
  const balances = subtotalPrinted && fedTax !== null &&
                   Math.abs(sum - total) <= 0.02 + (tip || 0);

  const group = inferGroup(clean, subtotal || 0, fedTax || 0, provTax || 0);

  const fedNo = clean.match(RX.fedNo);
  const provNo = clean.match(RX.provNo);

  let confidence = 'low';
  if (balances) confidence = 'high';
  else if (fedTax !== null || totalCandidates.length) confidence = 'medium';

  const note = balances ? null
    : (fedTax === null ? 'No tax line was readable — check the tax boxes.'
       : !subtotalPrinted ? 'No subtotal was printed, so the tax could not be checked.'
                          : 'The tax does not add up to the total; check it.');

  const nameAt = merchantLine(lines);

  return {
    merchant: findMerchant(lines, nameAt),
    address: findAddress(lines, nameAt),
    phone: findPhone(body),
    date: findDate(clean),
    time: findTime(body),
    total: total,
    subtotal: subtotal,
    federal_tax: fedTax,
    provincial_tax: provTax,
    tax_group: group,
    category: '',
    federal_tax_number: fedNo ? fedNo[1].replace(/\s+/g, ' ').toUpperCase() : null,
    provincial_tax_number: provNo ? provNo[1].replace(/\s+/g, ' ').toUpperCase() : null,
    tip: tip,
    confidence: confidence,
    note: note
  };
}

/* Uploads the photo asking Drive for a Google Doc back. That conversion is
   what runs the OCR, and it is free. The temp document is deleted the
   moment its text has been read — including when reading it fails, so a
   stray file never accumulates in your receipts folder. */
async function ocrViaDrive(blob, isPdf) {
  await ensureToken();
  const rootId = await rootFolderId();

  const meta = {
    name: '~ocr-temp',
    mimeType: 'application/vnd.google-apps.document',
    parents: [rootId]
  };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  /* Drive decides how to convert from the part's own type, so a PDF has to
     arrive named and typed as one — it OCRs those exactly as it does an
     image. */
  form.append('file', blob, isPdf ? 'receipt.pdf' : 'receipt.jpg');

  const up = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    { method: 'POST', headers: { Authorization: 'Bearer ' + accessToken }, body: form }
  );
  if (up.status === 401) { accessToken = null; tokenExp = 0; throw new Error('auth-expired'); }
  if (!up.ok) throw new Error('drive-upload-' + up.status);
  const id = (await up.json()).id;

  try {
    const ex = await fetch(
      'https://www.googleapis.com/drive/v3/files/' + id + '/export?mimeType=text/plain',
      { headers: { Authorization: 'Bearer ' + accessToken } }
    );
    if (!ex.ok) throw new Error('drive-export-' + ex.status);
    return await ex.text();
  } finally {
    /* Tidying up must never cost us a receipt we have already read. A bare
       .catch() would only cover an async rejection — the try/catch also
       covers fetch throwing outright, which would otherwise escape this
       finally block and discard the text we came here for. */
    try {
      fetch('https://www.googleapis.com/drive/v3/files/' + id, {
        method: 'DELETE', headers: { Authorization: 'Bearer ' + accessToken }
      }).catch(() => {});
    } catch (e) { /* the temp doc can be tidied later; the receipt matters more */ }
  }
}

/* A PDF is a perfectly good receipt — emailed ones nearly always are. Google
   OCRs a PDF on conversion just as it does an image, and Claude takes one as
   a document, so both readers handle them. The size guard exists because a
   PDF is never shrunk on the way in the way a photo is. */
const MAX_PDF_BYTES = 4.5 * 1024 * 1024;

/* Which reader is in use. Someone who had already set up the Claude Worker
   keeps it; everybody else gets the free one, which needs no setting up. */
function readerMode() {
  const explicit = S.get('cfg_reader', null);
  if (explicit) return explicit;
  return cfg('aiUrl') ? 'ai' : 'drive';
}

const DRIVE_CAUSES = {
  no_drive:  { msg: 'Reading receipts uses your Google Drive connection, which is not set up yet.',
               fix: 'Open Settings and tap Connect Drive.' },
  no_text:   { msg: 'No text could be made out in that photo.',
               fix: 'Try again in better light, or type it in.' },
  no_fields: { msg: 'The text came out but no amount could be found in it.',
               fix: 'Type it in — the photo still uploads with the receipt.' }
};

function explainDriveFailure(e) {
  const m = String((e && e.message) || e);
  if (m === 'timeout') {
    return { code: 'upstream', transient: true,
             msg: 'Google Drive took too long to answer.',
             fix: 'Tap Read to try again, or type it in.' };
  }
  if (!navigator.onLine) {
    return { code: 'offline', transient: true,
             msg: 'No connection, so the receipt cannot be read here.',
             fix: 'Type it in — saving works offline and uploads later.' };
  }
  if (m === 'auth-expired' || /-401$/.test(m)) {
    return { code: 'no_drive',
             msg: 'The Google sign-in has lapsed, so Drive could not read the photo.',
             fix: 'Open Settings and tap Connect Drive.' };
  }
  if (/-403$/.test(m)) {
    return { code: 'quota', transient: true,
             msg: 'Google turned the request down — usually the daily free limit.',
             fix: 'Try again later, or type it in.' };
  }
  if (/^drive-(upload|export)-5/.test(m)) {
    return { code: 'upstream', transient: true,
             msg: 'Google Drive did not answer properly.',
             fix: 'Tap Read to try again.' };
  }
  return { code: 'unknown',
           msg: 'Drive could not read that photo.',
           fix: 'Type it in — that always works.' };
}

/* The Drive read is several requests deep — a token refresh, a folder
   lookup, an upload, an export — and any one of them can hang rather than
   fail. One deadline over the whole thing is what guarantees the spinner
   always stops, which is the entire point of this app's error handling. */
function withDeadline(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })
  ]).finally(() => clearTimeout(timer));
}

async function tryReadDrive() {
  if (!pending) return { fail: { code: 'gone', msg: 'The photo was removed.', fix: 'Attach it again.' } };
  if (!connected() && !S.get('granted', false)) {
    return { fail: Object.assign({ code: 'no_drive' }, DRIVE_CAUSES.no_drive) };
  }
  let text;
  try {
    text = await withDeadline(ocrViaDrive(pending.blob, pending.ext === 'pdf'), SCAN_TIMEOUT_MS);
  } catch (e) {
    return { fail: explainDriveFailure(e) };
  }
  if (!String(text || '').trim()) {
    return { fail: Object.assign({ code: 'no_text' }, DRIVE_CAUSES.no_text) };
  }
  const fields = parseReceiptText(text);
  if (!fields) return { fail: Object.assign({ code: 'no_fields' }, DRIVE_CAUSES.no_fields) };
  return { fields };
}

function setScan(state, msg) {
  $('scanRow').className = 'scan' + (state === 'good' ? ' good' : state === 'bad' ? ' bad' : '');
  $('scanSpin').className = state === 'busy' ? 'spin' : 'spin hide';
  $('scanMsg').textContent = msg;
  $('scanBtn').textContent = state === 'busy' ? 'Reading' : state === 'good' ? 'Read again' : 'Read';
  $('scanBtn').disabled = state === 'busy';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('Could not read the image.'));
    r.readAsDataURL(blob);
  });
}

/* Fills what the form does not already have. Anything typed by hand wins —
   the scan is a head start, never an overwrite. */
function applyScan(f) {
  const filled = [];
  const put = (id, val, label) => {
    if (val === null || val === undefined || val === '') return;
    if ($(id).value.trim()) return;
    $(id).value = val;
    filled.push(label);
  };

  let group = '';
  if (f.tax_group && TAX_GROUPS.some((g) => g.code === f.tax_group)) {
    $('fTax').value = f.tax_group;
    S.set('lastTax', f.tax_group);
    applyTaxGroup(f.tax_group, false);
    group = f.tax_group;
  }
  if (f.category && CATEGORIES.indexOf(f.category) >= 0 && !catTouched) {
    $('fCat').value = f.category;
  }

  put('fName', f.merchant, 'merchant');
  put('fAddr', f.address, 'address');
  put('fPhone', f.phone, 'phone');
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.date || '')) { $('fDate').value = f.date; filled.push('date'); }
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(f.time || '')) { put('fTime', f.time, 'time'); }
  put('fTotal', f.total !== null && f.total !== undefined ? fixed(f.total) : '', 'total');

  const rt = taxRates($('fTax').value);
  put('fTps', f.federal_tax !== null && f.federal_tax !== undefined ? fixed(f.federal_tax) : '', rt.t1);
  if (rt.t2) put('fTvq', f.provincial_tax !== null && f.provincial_tax !== undefined ? fixed(f.provincial_tax) : '', rt.t2);

  const nosBefore = filled.length;
  put('fTpsNo', f.federal_tax_number, '');
  put('fTvqNo', f.provincial_tax_number, '');
  if (filled.length > nosBefore) filled.push('tax numbers');

  /* Nothing on the receipt broke out the tax, so derive it from the total. */
  if (!num($('fTps').value) && num($('fTotal').value) > 0 && f.federal_tax === null) {
    $('calcBtn').click();
    filled.push('taxes (calculated)');
  }

  if (group) filled.push('province ' + group);
  updateSums();
  return filled.filter(Boolean);
}

/* One attempt at the scanner. Resolves with what happened rather than
   throwing, so the decision about retrying lives in one place. */
async function tryScan(url) {
  if (!pending) return { fail: { code: 'gone', msg: 'The photo was removed.', fix: 'Attach it again.' } };
  let image, res;
  try {
    /* Reading the file is as capable of failing as sending it, and a throw
       here used to escape the caller entirely, leaving the spinner turning
       with the Read button disabled. */
    image = await blobToBase64(pending.blob);
  } catch (e) {
    return { fail: { code: 'unknown', msg: 'That photo could not be read off the phone.',
                     fix: 'Attach it again, or type the details in.' } };
  }
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image,
        mediaType: pending.ext === 'pdf' ? 'application/pdf'
                                         : (pending.blob.type || 'image/jpeg')
      })
    }, SCAN_TIMEOUT_MS);
  } catch (e) {
    return { fail: explainScanFailure(0, null, true) };
  }
  const data = await res.json().catch(() => null);
  if (res.ok && data && data.ok) return { fields: data.fields || {} };
  return { fail: explainScanFailure(res.status, data, false) };
}

async function scanReceipt(manual) {
  if (!pending) {
    if (manual) toast('Attach a photo or PDF first.', 'bad');
    return;
  }
  const isPdf = pending.ext === 'pdf';
  if (isPdf && pending.blob.size > MAX_PDF_BYTES) {
    setScan('bad', 'That PDF is too big to read. It still uploads with the receipt — type the details in.');
    return;
  }

  const mode = readerMode();
  if (mode === 'off') {
    setScan('', 'Reading is switched off. Fill the fields in below.');
    return;
  }
  const url = cfg('aiUrl');
  if (mode === 'ai' && !url) {
    setScan('', 'No scanner URL set. Fill the fields in below — that always works.');
    return;
  }

  const attempt = () => (mode === 'drive' ? tryReadDrive() : tryScan(url));
  const what = isPdf ? 'PDF' : 'receipt';
  setScan('busy', mode === 'drive' ? 'Reading ' + what + ' with Google Drive…'
                                   : 'Reading ' + what + '…');

  /* A rate limit or a hiccup upstream is worth exactly one more try. A
     missing key or a deleted Worker will not fix itself in 1.5 seconds. */
  let out = await attempt();
  if (out.fail && out.fail.transient && out.fail.code !== 'offline') {
    setScan('busy', 'Busy — trying once more…');
    await new Promise((r) => setTimeout(r, 1500));
    /* Someone can clear the preview or attach a different photo while that
       pause runs. Retrying then would read the wrong file, or none. */
    if (!pending) { setScan('', 'Attach a photo to have it read.'); return; }
    out = await attempt();
  }

  if (out.fail) {
    noteScanFail(out.fail);
    setScan('bad', out.fail.msg + ' ' + out.fail.fix +
      (scannerOffline() ? ' Pausing the scanner for now — everything else keeps working.' : ''));
    paintScannerState();
    return;
  }

  noteScanOk();
  paintScannerState();

  const f = out.fields;
  const filled = applyScan(f);

  if (f.confidence === 'low') {
    setScan('bad', f.note || 'Hard to read — check every field before saving.');
  } else if (!filled.length) {
    setScan('bad', 'Nothing new to fill in. Check the fields yourself.');
  } else {
    setScan('good', 'Filled in ' + filled.join(', ') +
      (f.confidence === 'medium' ? '. Worth a quick check.' : '. Check it over.'));
  }
}

function collect() {
  const date = $('fDate').value || todayISO();
  const total = num($('fTotal').value);
  const name = $('fName').value.trim();
  return {
    date,
    time: $('fTime').value,
    name,
    addr: $('fAddr').value.trim(),
    phone: $('fPhone').value.trim(),
    cat: $('fCat').value,
    purpose: $('fPurpose').value.trim(),
    tax: $('fTax').value,
    total,
    tps: num($('fTps').value),
    tvq: num($('fTvq').value),
    tpsNo: $('fTpsNo').value.trim(),
    tvqNo: $('fTvqNo').value.trim()
  };
}

function rememberVendor(m) {
  if (!m.name) return;
  const v = S.get('vendors', {});
  const key = m.name.toLowerCase();
  /* Keep whatever we already knew when this receipt did not say. A blurred
     photo should not erase the address a clear one taught us. */
  const was = v[key] || {};
  v[key] = { label: m.name, tpsNo: m.tpsNo, tvqNo: m.tvqNo, cat: m.cat, tax: m.tax,
             addr: m.addr || was.addr || '', phone: m.phone || was.phone || '' };
  S.set('vendors', v);
  paintMerchants();
}

/* Uploads one queued job. Throws on failure so the caller can keep it queued. */
async function uploadJob(job) {
  await ensureToken();
  const rootId = await rootFolderId();
  const folderId = await folderForDate(rootId, job.meta.date);
  const m = job.meta;
  const sub = m.total - m.tps - m.tvq;

  const g = taxGroup(m.tax || 'QC');
  const rt = taxRates(m.tax || 'QC');

  const base = m.date + ' ' + safeName(m.cat.split(' ')[0]) + ' ' + safeName(m.name) + ' ' + fixed(m.total);
  const desc =
    'Merchant: ' + m.name +
    (m.addr ? '\nAddress: ' + m.addr : '') +
    (m.phone ? '\nPhone: ' + m.phone : '') +
    '\nDate: ' + m.date + (m.time ? ' ' + m.time : '') +
    '\nCategory: ' + m.cat +
    '\nPurpose: ' + m.purpose + '\nTax group: ' + g.name + ' (' + g.code + ')' +
    '\nSubtotal: ' + fixed(sub) +
    '\n' + rt.t1 + ': ' + fixed(m.tps) +
    (rt.t2 ? '\n' + rt.t2 + ': ' + fixed(m.tvq) : '') +
    '\nTotal: ' + fixed(m.total) +
    (m.tpsNo ? '\n' + rt.t1 + ' number: ' + m.tpsNo : '') +
    (m.tvqNo && rt.t2 ? '\n' + rt.t2 + ' number: ' + m.tvqNo : '');
  const props = {
    date: m.date, merchant: m.name.slice(0, 100), category: m.cat, taxGroup: g.code,
    total: fixed(m.total), tps: fixed(m.tps), tvq: fixed(m.tvq)
  };
  /* Drive rejects an empty appProperties value, so only set what we have. */
  if (m.addr) props.address = m.addr.slice(0, 120);
  if (m.phone) props.phone = m.phone;
  if (m.time) props.time = m.time;

  let fileName, link = '';
  if (job.blob) {
    fileName = base + '.' + (job.ext || 'jpg');
    const up = await uploadFile(job.blob, fileName, folderId, desc, props);
    link = up.webViewLink || '';
  } else {
    fileName = base + '.txt';
    const up = await uploadFile(new Blob([desc], { type: 'text/plain' }), fileName, folderId, desc, props);
    link = up.webViewLink || '';
  }

  await appendToIndex(rootId, [
    m.date, m.time || '', m.name, m.addr || '', m.phone || '',
    m.cat, m.purpose, g.code, fixed(sub), fixed(m.tps), fixed(m.tvq),
    fixed(m.total), m.tpsNo, m.tvqNo, fileName, link, new Date().toISOString()
  ]);

  return { fileName, link };
}

async function flushQueue(loud) {
  let jobs = [];
  try { jobs = await qAll(); } catch (e) { return; }
  if (!jobs.length) { if (loud) toast('Nothing waiting to upload.'); return; }
  if (!cfg('clientId')) { if (loud) toast('Add your Client ID in Settings first.', 'bad'); return; }

  let done = 0, failed = 0;
  for (const job of jobs) {
    try {
      const r = await uploadJob(job);
      await qDel(job.id);
      updateHistory(job.id, { status: 'saved', link: r.link, file: r.fileName });
      done++;
    } catch (e) {
      failed++;
      if (String(e.message).indexOf('auth') >= 0 || String(e.message) === 'no-client-id') break;
    }
  }
  paintHistory(); refreshPending();
  if (done && !failed) toast(done + ' receipt' + (done > 1 ? 's' : '') + ' uploaded to Drive.', 'good');
  else if (done) toast(done + ' uploaded, ' + failed + ' still waiting.', 'bad');
  else if (loud) toast('Upload failed. Check your connection, then Connect Drive in Settings.', 'bad');
}

async function save() {
  const m = collect();
  if (!m.name) { toast('Enter the merchant name.', 'bad'); $('fName').focus(); return; }
  if (!(m.total > 0)) { toast('Enter the total amount.', 'bad'); $('fTotal').focus(); return; }

  const btn = $('saveBtn');
  btn.disabled = true; btn.textContent = 'Saving...';

  /* Ask for the token while still inside the tap, so iOS allows the popup. */
  let tokenPromise = null;
  if (cfg('clientId') && !connected()) tokenPromise = requestToken(true).catch(() => null);

  const id = uid();
  const job = { id, meta: m, blob: pending ? pending.blob : null, ext: pending ? pending.ext : null };

  pushHistory({
    id, date: m.date, name: m.name, cat: m.cat, purpose: m.purpose, tax: m.tax,
    total: m.total, tps: m.tps, tvq: m.tvq, tpsNo: m.tpsNo, tvqNo: m.tvqNo,
    thumb: pending ? pending.thumb : '', status: 'pending', link: ''
  });
  rememberVendor(m);
  try { await qPut(job); } catch (e) {}
  paintHistory(); refreshPending();

  if (tokenPromise) await tokenPromise;

  try {
    if (!cfg('clientId')) throw new Error('no-client-id');
    const r = await uploadJob(job);
    await qDel(id);
    updateHistory(id, { status: 'saved', link: r.link, file: r.fileName });
    toast('Saved to Drive: ' + r.fileName, 'good');
    resetForm(true);
  } catch (e) {
    const msg = String(e.message || e);
    if (msg === 'no-client-id') toast('Saved on this phone. Add your Client ID in Settings to upload.', 'bad');
    else if (msg.indexOf('auth') >= 0) toast('Saved on this phone. Tap Connect Drive in Settings.', 'bad');
    else toast('Saved on this phone. Upload failed, will retry: ' + msg.slice(0, 90), 'bad');
    resetForm(true);
  } finally {
    btn.disabled = false; btn.textContent = 'Save to Drive';
    paintHistory(); refreshPending(); paintStatus();
  }
}

/* ---------------------------------------------------------------- wiring */

function showTab(name) {
  ['new', 'hist', 'set'].forEach((t) => {
    $('t-' + t).className = t === name ? '' : 'hide';
  });
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.className = b.dataset.tab === name ? 'sel' : '';
  });
  $('title').textContent = name === 'new' ? 'New receipt' : (name === 'hist' ? 'History' : 'Settings');
  $('bar').className = name === 'new' ? 'bar' : 'bar hide';
  if (name === 'hist') paintHistory();
}

function boot() {
  const cameBack = consumeRedirectAuth();

  $('fCat').innerHTML = CATEGORIES.map((c) => '<option>' + c + '</option>').join('');
  $('fDate').value = todayISO();
  $('fCat').value = S.get('lastCat', 'Restaurant');

  const taxOpts = TAX_GROUPS.map((g) => '<option value="' + g.code + '">' + g.name + '</option>').join('');
  $('fTax').innerHTML = taxOpts;
  $('sTaxDefault').innerHTML = taxOpts;
  $('sTaxDefault').value = cfg('taxGroup');
  $('fTax').value = S.get('lastTax', cfg('taxGroup'));
  applyTaxGroup($('fTax').value, false);

  $('sCid').value = cfg('clientId');
  $('sRoot').value = cfg('root');
  $('sStruct').value = cfg('struct');
  $('sTps').value = cfg('tpsRate');
  $('sTvq').value = cfg('tvqRate');
  $('sQual').value = cfg('maxPx');
  $('sAi').value = cfg('aiUrl');
  $('sAuto').value = cfg('autoScan');
  $opt('sReader').value = readerMode();
  $('sOrigin').value = location.origin;
  $('sRedir').value = redirectUri();
  $opt('sVer').value = APP_VERSION;

  document.querySelectorAll('.tabs button').forEach((b) => {
    b.addEventListener('click', () => showTab(b.dataset.tab));
  });

  $('camBtn').addEventListener('click', () => $('camIn').click());
  $('libBtn').addEventListener('click', () => $('libIn').click());
  $('camIn').addEventListener('change', (e) => { attach(e.target.files[0]); e.target.value = ''; });
  $('libIn').addEventListener('change', (e) => { attach(e.target.files[0]); e.target.value = ''; });
  $('prevX').addEventListener('click', clearPreview);

  ['fTotal', 'fTps', 'fTvq'].forEach((k) => $(k).addEventListener('input', updateSums));
  $('fCat').addEventListener('change', () => {
    catTouched = true;
    S.set('lastCat', $('fCat').value);
  });
  $('scanBtn').addEventListener('click', () => scanReceipt(true));
  $('fTax').addEventListener('change', () => {
    S.set('lastTax', $('fTax').value);
    applyTaxGroup($('fTax').value, true);
  });

  $('calcBtn').addEventListener('click', () => {
    const total = num($('fTotal').value);
    if (!(total > 0)) { toast('Enter the total first.', 'bad'); return; }
    const rt = taxRates($('fTax').value);
    const r1 = rt.r1 / 100, r2 = rt.r2 / 100;
    const sub = total / (1 + r1 + r2);
    $('fTps').value = fixed(sub * r1);
    $('fTvq').value = rt.t2 ? fixed(sub * r2) : '0.00';
    updateSums();
  });
  $('zeroBtn').addEventListener('click', () => {
    $('fTps').value = '0.00'; $('fTvq').value = '0.00'; updateSums();
  });

  $('fName').addEventListener('change', () => {
    const v = S.get('vendors', {})[$('fName').value.trim().toLowerCase()];
    if (!v) return;
    if (v.tax && v.tax !== $('fTax').value) {
      $('fTax').value = v.tax;
      applyTaxGroup(v.tax, false);
    }
    if (!$('fTpsNo').value) $('fTpsNo').value = v.tpsNo || '';
    if (!$('fTvqNo').value) $('fTvqNo').value = v.tvqNo || '';
    if (!$('fAddr').value) $('fAddr').value = v.addr || '';
    if (!$('fPhone').value) $('fPhone').value = v.phone || '';
    if (v.cat) $('fCat').value = v.cat;
  });

  $('saveBtn').addEventListener('click', save);
  $('retryBtn').addEventListener('click', () => flushQueue(true));
  $('pendBtn').addEventListener('click', () => { showTab('hist'); flushQueue(true); });

  $('connBtn').addEventListener('click', () => {
    const id = $('sCid').value.trim();
    if (!id) { toast('Paste your OAuth Client ID first.', 'bad'); return; }
    setCfg('clientId', id);
    if (!initTokenClient()) { toast('Google sign-in script did not load. Check your connection.', 'bad'); return; }
    requestToken(false)
      .then(() => {
        toast('Connected to Google Drive.', 'good');
        /* A fresh install trips the breaker on "not connected" before you
           ever reach this button. Connecting is the fix, so clear it now
           rather than leaving the reader paused for a quarter of an hour. */
        noteScanOk();
        paintScannerState();
        flushQueue(false);
      })
      .catch((e) => toast('Sign-in cancelled or blocked (' + e.message + ').', 'bad'));
  });
  $('discBtn').addEventListener('click', signOut);

  $('connAlt').addEventListener('click', () => {
    const id = $('sCid').value.trim();
    if (id) setCfg('clientId', id);
    startRedirectAuth();
  });

  $('copyUris').addEventListener('click', () => {
    const txt = 'JavaScript origin: ' + location.origin + '\nRedirect URI: ' + redirectUri();
    if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => toast('Copied.', 'good'), () => {});
    else toast(txt);
  });

  $('saveSet').addEventListener('click', () => {
    const prevRoot = cfg('root');
    const prevAi = cfg('aiUrl');
    setCfg('clientId', $('sCid').value.trim());
    setCfg('root', $('sRoot').value.trim() || 'receipts');
    setCfg('struct', $('sStruct').value);
    setCfg('aiUrl', $('sAi').value.trim().replace(/\/+$/, ''));
    /* Pointing at a different Worker makes the old failures meaningless. */
    if (prevAi !== cfg('aiUrl')) noteScanOk();
    setCfg('reader', $opt('sReader').value);
    setCfg('autoScan', $('sAuto').value);
    setCfg('taxGroup', $('sTaxDefault').value);
    setCfg('tpsRate', $('sTps').value.trim() || '5');
    setCfg('tvqRate', $('sTvq').value.trim() || '9.975');
    setCfg('maxPx', $('sQual').value);
    if (prevRoot !== cfg('root')) S.del('rootId');
    applyTaxGroup($('fTax').value, false);
    paintStatus();
    paintReaderMode();
    paintScannerState();
    toast('Settings saved.', 'good');
  });

  /* Two questions, asked in that order: is the Worker there at all, and can
     it reach Claude. Answering them separately is what turns "the scanner
     doesn't work" into a sentence naming the thing to go and fix. */
  $('aiTest').addEventListener('click', async () => {
    const url = $('sAi').value.trim().replace(/\/+$/, '');
    if (!url) { toast('Paste the scanner URL first.', 'bad'); return; }
    setCfg('aiUrl', url);
    const btn = $('aiTest');
    btn.disabled = true; btn.textContent = 'Testing…';
    try {
      /* Any HTTP reply at all means the Worker exists. An older Worker
         answers GET with 405, which still proves it is alive. */
      let health = null, reachable = false;
      try {
        const hr = await fetchWithTimeout(url, { method: 'GET' }, 15000);
        reachable = true;
        health = await hr.json().catch(() => null);
      } catch (e) { reachable = false; }

      if (!reachable) {
        const info = explainScanFailure(0, null, true);
        noteScanFail(info);
        throw new Error(info.msg + ' ' + info.fix);
      }
      if (health && health.keyConfigured === false) {
        const info = Object.assign({ code: 'no_key' }, SCAN_CAUSES.no_key);
        noteScanFail(info);
        throw new Error(info.msg + ' ' + info.fix);
      }

      const c = document.createElement('canvas');
      c.width = 400; c.height = 300;
      const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, 400, 300);
      x.fillStyle = '#000'; x.font = 'bold 22px sans-serif';
      x.fillText('CAFE ESSAI', 20, 44);
      x.font = '18px sans-serif';
      x.fillText('Montreal QC   2026-08-23', 20, 82);
      x.fillText('Sous-total        10.00', 20, 140);
      x.fillText('TPS               0.50', 20, 172);
      x.fillText('TVQ               1.00', 20, 204);
      x.font = 'bold 20px sans-serif';
      x.fillText('TOTAL            11.50', 20, 250);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
      const image = await blobToBase64(blob);
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image, mediaType: 'image/jpeg' })
      }, SCAN_TIMEOUT_MS);
      const d = await res.json().catch(() => null);
      if (!res.ok || !d || !d.ok) {
        const info = explainScanFailure(res.status, d, false);
        noteScanFail(info);
        throw new Error(info.msg + ' ' + info.fix);
      }
      noteScanOk();
      const f = d.fields || {};
      toast('Scanner works. It read ' + (f.merchant || '?') + ', total ' +
            (f.total === null ? '?' : f.total) + ', ' + (f.tax_group || '?') + '.', 'good');
    } catch (e) {
      toast(String(e.message || e).slice(0, 140), 'bad');
    } finally {
      btn.disabled = false; btn.textContent = 'Test the scanner';
      paintScannerState();
    }
  });

  /* The pause is a convenience, never a lock. This clears it on demand so a
     scanner you have just fixed is usable without waiting out the cooldown. */
  $opt('sReader').addEventListener('change', () => {
    setCfg('reader', $opt('sReader').value);
    /* A different reader has nothing to do with the last one's failures. */
    noteScanOk();
    paintReaderMode();
    paintScannerState();
  });

  $opt('aiWake').addEventListener('click', () => {
    noteScanOk();
    paintScannerState();
    toast('Scanner switched back on.', 'good');
  });

  /* The two halves of getting out of a bad build. Neither touches receipts,
     settings or the upload queue — those live in localStorage and IndexedDB,
     and only the stored copy of the app itself is thrown away. */
  $opt('updBtn').addEventListener('click', async () => {
    const btn = $opt('updBtn');
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
      if (!('serviceWorker' in navigator)) {
        toast('This browser keeps no copy of the app, so it is always current.');
        return;
      }
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) { toast('Nothing stored yet — this is the current version.'); return; }
      await reg.update();

      /* A build that has finished downloading is applied here and now rather
         than left waiting for a cold start — being told an update exists but
         not getting it is exactly the stuck feeling this button is for. */
      if (reg.waiting) {
        reg.waiting.postMessage('skipWaiting');
        toast('Newer version installed. Reloading…', 'good');
        setTimeout(() => location.reload(), 600);
        return;
      }
      if (reg.installing) {
        toast('A newer version is downloading. Tap this again in a moment.', 'good');
        return;
      }
      toast('Version ' + APP_VERSION + ' is the newest there is.', 'good');
    } catch (e) {
      toast('Could not check for an update: ' + String(e.message || e).slice(0, 80), 'bad');
    } finally {
      btn.disabled = false; btn.textContent = 'Check for update';
    }
  });

  $opt('fixBtn').addEventListener('click', () => {
    if (!confirm('Repair the app?\n\nReceipts, settings and anything waiting to upload are all kept. The app reloads with a fresh copy of itself.')) return;
    repairApp();
  });

  $('csvBtn').addEventListener('click', () => {
    const rows = [CSV_HEADER].concat(getHistory().map((r) => [
      r.date, r.time || '', r.name, r.addr || '', r.phone || '', r.cat, r.purpose, r.tax || 'QC',
      fixed(r.total - r.tps - r.tvq), fixed(r.tps), fixed(r.tvq),
      fixed(r.total), r.tpsNo || '', r.tvqNo || '', r.file || '', r.link || '', r.status
    ]));
    const blob = new Blob(['﻿' + rows.map(csvRow).join('')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'receipts-backup.csv';
    a.click();
  });

  $('wipeBtn').addEventListener('click', () => {
    if (!confirm('Clear the on-phone list? Files already in Google Drive are not touched.')) return;
    S.del('hist'); paintHistory(); toast('Local list cleared.');
  });

  paintMerchants();
  paintHistory();
  paintStatus();
  paintReaderMode();
  paintScannerState();
  updateSums();

  if (cameBack) {
    showTab('set');
    toast('Connected to Google Drive.', 'good');
    flushQueue(false);
  }

  /* Reconnect quietly and drain anything left over from last time. */
  const tryResume = () => {
    if (!cfg('clientId') || !window.google) return;
    initTokenClient();
    if (connected()) flushQueue(false);
    else if (S.get('granted', false)) requestToken(true).then(() => flushQueue(false)).catch(() => {});
  };
  setTimeout(tryResume, 1200);
  window.addEventListener('online', () => flushQueue(false));

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      /* Say so when a newer build lands behind this one. The service worker
         takes over immediately, but the page already running keeps the code
         it started with, so the honest thing to promise is "next time". */
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('A new version is ready. It is used next time you open the app.', 'good');
          }
        });
      });
    }).catch(() => {});
  }
}

/* Throws away every stored copy of the app and reloads. Receipts, settings
   and the upload queue live in localStorage and IndexedDB and are untouched;
   only the service worker and its caches go. Deliberately defined outside
   boot() so it still works when boot() is the thing that broke. */
async function repairApp() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (e) { /* Reload regardless — a half-cleared cache beats the old one. */ }
  /* The query string defeats any copy the browser itself is still holding.
     redirectUri() ignores the query, so Google sign-in is unaffected. */
  location.replace(location.pathname + '?fresh=' + Date.now());
}

/* A thrown error must never leave a screen that has quietly stopped
   responding — that is the one failure you cannot diagnose from a phone.
   These say what happened and point at the button that fixes it. */
function reportCrash(what) {
  const msg = String(what || 'Something went wrong').slice(0, 110);
  try { toast(msg + ' — if this keeps happening, tap Repair app in Settings.', 'bad'); }
  catch (e) { /* Too early for the DOM; the console entry is all there is. */ }
}

window.addEventListener('error', (e) => reportCrash(e && e.message));
window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  reportCrash(r && (r.message || r));
});

document.addEventListener('DOMContentLoaded', () => {
  try {
    boot();
  } catch (e) {
    /* Half-wired listeners are worse than none, so make the state obvious
       and put the way out on screen rather than in a toast that fades. */
    reportCrash(e && e.message);
    /* Settings may never have been wired up, so the way out cannot be a
       button in Settings. Put it in the banner and make it do the work. */
    const warn = $('setupWarn');
    if (warn) {
      warn.className = 'banner bad';
      warn.innerHTML = '';
      warn.appendChild(document.createTextNode('The app did not start properly. '));
      const fix = document.createElement('button');
      fix.className = 'chip';
      fix.textContent = 'Repair the app';
      fix.addEventListener('click', repairApp);
      warn.appendChild(fix);
    }
  }
});
