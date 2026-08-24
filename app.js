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

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

const CSV_NAME = 'receipts-index.csv';
const CSV_HEADER = ['Date','Merchant','Category','Purpose','Subtotal','TPS','TVQ',
                    'Total','TPS number','TVQ number','File','Drive link','Saved at'];

const DEFAULTS = {
  clientId: '',
  root: 'receipts',
  struct: 'ym',
  tpsRate: '5',
  tvqRate: '9.975',
  maxPx: '1600'
};

/* ------------------------------------------------------------- utilities */

const $ = (id) => document.getElementById(id);

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

function num(v) {
  if (v === null || v === undefined) return 0;
  const n = parseFloat(String(v).replace(/[^0-9.,-]/g, '').replace(',', '.'));
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

function redirectUri() { return location.origin + location.pathname; }

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

async function appendToIndex(rootId, row) {
  let id = await findChild(CSV_NAME, rootId, false);
  let body;
  if (id) {
    const cur = await (await drive('/files/' + id + '?alt=media')).text();
    body = (cur.endsWith('\n') || cur === '' ? cur : cur + '\r\n') + csvRow(row);
  } else {
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

function shrinkImage(file, maxPx) {
  return new Promise((resolve) => {
    if (file.type === 'application/pdf') return resolve({ blob: file, ext: 'pdf', thumb: '' });
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
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

      c.toBlob((blob) => {
        URL.revokeObjectURL(url);
        resolve({ blob: blob || file, ext: 'jpg', thumb });
      }, 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve({ blob: file, ext: 'jpg', thumb: '' }); };
    img.src = url;
  });
}

/* ------------------------------------------------------------ app state  */

let pending = null;   // { blob, ext, thumb } for the photo currently attached

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
  $('merchants').innerHTML = Object.keys(v).map((k) => '<option value="' + (v[k].label || k).replace(/"/g, '') + '">').join('');
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

function resetForm(keepDate) {
  if (!keepDate) $('fDate').value = todayISO();
  $('fTotal').value = ''; $('fName').value = ''; $('fPurpose').value = '';
  $('fTps').value = ''; $('fTvq').value = ''; $('fTpsNo').value = ''; $('fTvqNo').value = '';
  pending = null;
  $('prev').className = 'prev hide';
  $('prevImg').removeAttribute('src');
  updateSums();
}

async function attach(file) {
  if (!file) return;
  toast('Processing photo...');
  pending = await shrinkImage(file, parseInt(cfg('maxPx'), 10));
  const url = URL.createObjectURL(pending.blob);
  $('prevImg').src = url;
  $('prev').className = 'prev';
  $('prevSz').textContent = (pending.blob.size / 1024).toFixed(0) + ' KB';
  toast('Photo attached. Fill in the details.', 'good');
}

function collect() {
  const date = $('fDate').value || todayISO();
  const total = num($('fTotal').value);
  const name = $('fName').value.trim();
  return {
    date,
    name,
    cat: $('fCat').value,
    purpose: $('fPurpose').value.trim(),
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
  v[key] = { label: m.name, tpsNo: m.tpsNo, tvqNo: m.tvqNo, cat: m.cat };
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

  const base = m.date + ' ' + safeName(m.cat.split(' ')[0]) + ' ' + safeName(m.name) + ' ' + fixed(m.total);
  const desc =
    'Merchant: ' + m.name + '\nDate: ' + m.date + '\nCategory: ' + m.cat +
    '\nPurpose: ' + m.purpose + '\nSubtotal: ' + fixed(sub) +
    '\nTPS: ' + fixed(m.tps) + '\nTVQ: ' + fixed(m.tvq) + '\nTotal: ' + fixed(m.total) +
    (m.tpsNo ? '\nTPS number: ' + m.tpsNo : '') +
    (m.tvqNo ? '\nTVQ number: ' + m.tvqNo : '');
  const props = {
    date: m.date, merchant: m.name.slice(0, 100), category: m.cat,
    total: fixed(m.total), tps: fixed(m.tps), tvq: fixed(m.tvq)
  };

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
    m.date, m.name, m.cat, m.purpose, fixed(sub), fixed(m.tps), fixed(m.tvq),
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
    id, date: m.date, name: m.name, cat: m.cat, purpose: m.purpose,
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

  $('sCid').value = cfg('clientId');
  $('sRoot').value = cfg('root');
  $('sStruct').value = cfg('struct');
  $('sTps').value = cfg('tpsRate');
  $('sTvq').value = cfg('tvqRate');
  $('sQual').value = cfg('maxPx');
  $('sOrigin').value = location.origin;
  $('sRedir').value = redirectUri();

  document.querySelectorAll('.tabs button').forEach((b) => {
    b.addEventListener('click', () => showTab(b.dataset.tab));
  });

  $('camBtn').addEventListener('click', () => $('camIn').click());
  $('libBtn').addEventListener('click', () => $('libIn').click());
  $('camIn').addEventListener('change', (e) => { attach(e.target.files[0]); e.target.value = ''; });
  $('libIn').addEventListener('change', (e) => { attach(e.target.files[0]); e.target.value = ''; });
  $('prevX').addEventListener('click', () => {
    pending = null; $('prev').className = 'prev hide'; $('prevImg').removeAttribute('src');
  });

  ['fTotal', 'fTps', 'fTvq'].forEach((k) => $(k).addEventListener('input', updateSums));
  $('fCat').addEventListener('change', () => S.set('lastCat', $('fCat').value));

  $('calcBtn').addEventListener('click', () => {
    const total = num($('fTotal').value);
    if (!(total > 0)) { toast('Enter the total first.', 'bad'); return; }
    const r1 = num(cfg('tpsRate')) / 100, r2 = num(cfg('tvqRate')) / 100;
    const sub = total / (1 + r1 + r2);
    $('fTps').value = fixed(sub * r1);
    $('fTvq').value = fixed(sub * r2);
    updateSums();
  });
  $('zeroBtn').addEventListener('click', () => {
    $('fTps').value = '0.00'; $('fTvq').value = '0.00'; updateSums();
  });

  $('fName').addEventListener('change', () => {
    const v = S.get('vendors', {})[$('fName').value.trim().toLowerCase()];
    if (!v) return;
    if (!$('fTpsNo').value) $('fTpsNo').value = v.tpsNo || '';
    if (!$('fTvqNo').value) $('fTvqNo').value = v.tvqNo || '';
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
      .then(() => { toast('Connected to Google Drive.', 'good'); flushQueue(false); })
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
    setCfg('clientId', $('sCid').value.trim());
    setCfg('root', $('sRoot').value.trim() || 'receipts');
    setCfg('struct', $('sStruct').value);
    setCfg('tpsRate', $('sTps').value.trim() || '5');
    setCfg('tvqRate', $('sTvq').value.trim() || '9.975');
    setCfg('maxPx', $('sQual').value);
    if (prevRoot !== cfg('root')) S.del('rootId');
    paintStatus();
    toast('Settings saved.', 'good');
  });

  $('csvBtn').addEventListener('click', () => {
    const rows = [CSV_HEADER].concat(getHistory().map((r) => [
      r.date, r.name, r.cat, r.purpose, fixed(r.total - r.tps - r.tvq), fixed(r.tps), fixed(r.tvq),
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
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', boot);
