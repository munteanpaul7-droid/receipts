# Receipts

An app for your iPhone that photographs a receipt, files the picture into
Google Drive under `receipts / 2026 / 2026-08 August`, and logs every amount,
tax and category into a spreadsheet.

**Live at: <https://munteanpaul7-droid.github.io/receipts/>**

---

## Setup — already done

Nothing to configure. For the record, this is what is in place:

| | |
|---|---|
| Hosting | GitHub Pages, from `munteanpaul7-droid/receipts`, branch `main`, HTTPS enforced |
| Google account | munteanpaul7@gmail.com |
| Cloud project | `focused-elysium-501321-g9` ("My Project 92760") |
| Drive API | Enabled |
| Consent screen | External, Testing, test users munteanpaul7@gmail.com and paul@cleverpays.ca |
| OAuth client | "Receipts iPhone" — `74591076439-0hkmt….apps.googleusercontent.com` |
| JS origin | `https://munteanpaul7-droid.github.io` |
| Redirect URIs | `…/receipts/` and `…/receipts/index.html` |

The Client ID is compiled into `app.js`, so the app arrives pre-configured on
any device. That is safe: a web OAuth client ID is public by design and there
is no client secret in this flow.

---

## Put it on your iPhone

1. Open **Safari** (must be Safari, not another browser) and go to
   <https://munteanpaul7-droid.github.io/receipts/>
2. Tap **Share** (square with an arrow) → **Add to Home Screen** → **Add**.
3. Open it from the home screen. Go to **Settings** → **Connect Drive**.
   - Google warns *"Google hasn't verified this app."* Expected — it is your
     own app. Tap **Advanced** → **Go to Receipts (unsafe)** → **Continue**.
   - If the popup misbehaves, tap **Sign in without a popup** instead. Same
     result, via a full-page redirect, which is more reliable inside a
     home-screen app.
4. The dot at the top left turns **green**. Done.

---

## Using it

- **Scan with camera** opens the camera. **From photos** takes an existing
  picture or a PDF.
- Pick the **tax group** for where you bought it. It defaults to Quebec and
  remembers whichever you used last, so day to day you never touch it — but buy
  gas in Ontario and one tap switches the receipt to HST.
- Enter the total, then tap **Auto-calculate taxes from total** — it splits the
  tax at that province's rates. The fields rename themselves to match (TPS/TVQ
  in Quebec, HST in Ontario, GST/PST in BC), and provinces with a single
  combined tax show a single field. Everything stays editable; **No tax**
  zeroes it.

| Group | Rates | | Group | Rates |
|---|---|---|---|---|
| Quebec | TPS 5% + TVQ 9.975% | | Nova Scotia | HST 14% |
| Ontario | HST 13% | | New Brunswick | HST 15% |
| British Columbia | GST 5% + PST 7% | | Newfoundland and Labrador | HST 15% |
| Manitoba | GST 5% + RST 7% | | Prince Edward Island | HST 15% |
| Saskatchewan | GST 5% + PST 6% | | Alberta | GST 5% |
| Yukon, NWT, Nunavut | GST 5% | | Custom | your own two rates |

Rates are correct to May 2026 — note Nova Scotia dropped from 15% to 14% in
April 2025. If a rate ever changes, either edit `TAX_GROUPS` at the top of
`app.js` or switch that receipt to **Custom** and set the rates in Settings.
- Categories: Restaurant, Gas / Fuel, Groceries / Food, Furniture, Office
  supplies, Travel / Hotel, Vehicle / Maintenance, Utilities / Telecom,
  Professional services, Software / Subscriptions, Tools / Equipment,
  Advertising / Marketing, Other.
- TPS and TVQ registration numbers are optional and remembered per merchant —
  type the same shop name next time and they fill themselves in.
- **Save to Drive** files it.

### What lands in Drive

```
receipts/
  receipts-index.csv          <- every receipt, one row each
  2026/
    2026-08 August/
      2026-08-23 Restaurant Chez Ashton 114.98.jpg
      2026-08-24 Gas Ultramar 62.10.jpg
```

Open `receipts-index.csv` in Google Sheets and you have date, merchant,
category, purpose, tax group, subtotal, federal tax, provincial tax, total,
both registration numbers, the file name and a direct link. The tax columns are
named generically because their meaning shifts by province — federal holds GST,
HST or TPS, provincial holds PST, RST, QST or TVQ — and the **Tax group**
column (QC, ON, BC…) tells you which. Filter on it to total a single province. Each picture also carries the same details in its
Drive *description*, so searching Drive by merchant or amount finds it.

A manual entry with no photo is saved as a small `.txt` in the same folder, so
the month folder always matches the spreadsheet.

### If you have no signal

Save anyway. Receipts are stored on the phone and an hourglass appears in the
top bar. They upload by themselves next time you open the app on wifi, or tap
**History → Retry pending uploads**. Nothing is lost when an upload fails — the
photo is only cleared once Drive confirms it.

Google sign-ins last about an hour. If yours has lapsed, saving still works and
just queues; open Settings and tap **Connect Drive** to flush the queue.

---

## When the AI scanning stops working

The scanner is the one part of this app that leans on something outside your
phone: a small Cloudflare Worker holding an Anthropic key. Workers get deleted,
keys get rotated, credit runs out. **None of that stops you filing receipts** —
photographing, typing, saving and uploading to Drive never touch the scanner.
It only fills the fields in for you.

The app now says which of those things went wrong, in the scan strip on the New
tab and again under **Settings → AI scanning**:

| What it says | What actually happened | What fixes it |
|---|---|---|
| The scanner never answered | The Worker is deleted, asleep, or the URL is wrong | Check **Scanner URL**, then **Test the scanner** |
| Running but has no Anthropic key | The Worker lost its secret | Add `ANTHROPIC_API_KEY` as a secret on the Worker |
| Anthropic rejected the key | The key was revoked or rotated | Make a new key, update the Worker's secret |
| Out of credit | The Anthropic account is empty | Top it up; the scanner returns by itself |
| Rate-limiting | Too many reads too fast | Wait a minute and tap **Read** |
| Refuses requests from this address | The app is on a URL the Worker does not allow | Add that address to `ALLOWED_ORIGINS` in the Worker |
| Asking for a model that no longer exists | Claude retired that model | Change `MODEL` in `worker/receipt-ocr.js`, redeploy |

After three failures in a row the app **stops asking**. It will not paint a red
error over every receipt you file; it says the scanner is off, gets out of the
way, and tries again by itself a quarter of an hour later. Tapping **Read** on
any receipt tries immediately, and one success switches it straight back on —
as does **Turn the scanner back on** in Settings.

**Test the scanner** now asks two questions instead of one: it first checks the
Worker is alive at all (a plain `GET` that never touches Anthropic), then sends
a small drawn receipt through the whole chain. That is what separates "the
Worker is gone" from "the Worker is fine but the key is dead".

The Worker also looks after itself a little: it retries once on a rate limit or
a hiccup at Anthropic, and if the API ever rejects one of the optional
parameters it sends — `output_config`, `fallbacks`, the beta header — it
immediately retries without them. A retired parameter costs a little quality,
not the whole feature.

## If the app itself misbehaves

**Settings → App** shows the version on the phone and has two buttons.

- **Check for update** looks for a newer build and, if one is ready, applies it
  and reloads. GitHub Pages takes about a minute to publish after a push.
- **Repair app** throws away the phone's stored copy of the app and fetches it
  fresh. **Your receipts, settings, remembered merchants and anything waiting
  to upload are all kept** — they live in separate storage that this does not
  touch. Only the cached copy of the app itself is discarded.

If the app fails so early that Settings is unreachable, a red banner with a
**Repair the app** button appears on the first screen instead.

The stored copy no longer wins over the network. Earlier versions served the
cached app first and refreshed in the background, which meant a bad build, once
saved, kept opening forever. The app is now fetched fresh whenever the network
answers within a few seconds, and the stored copy is used only when it does
not — so it still opens with no signal, but it can no longer get stuck on a
broken version.

---

## Notes

- The app requests the `drive.file` permission only. It can see and touch
  **only the files and folders it created itself** — it cannot read the rest of
  your Drive.
- It creates the `receipts` folder itself on first save and remembers it. You
  can drag that folder anywhere in Drive afterwards, or rename it, and the app
  keeps writing to the same one.
- Folder name, default tax group, custom rates, photo size and the year/month
  layout are all in
  **Settings**.
- Nothing passes through anyone else's server. The only two parties are your
  phone and Google.
- The consent screen is in *Testing* mode, which is correct here — it keeps the
  app private to the two test-user accounts. It does not expire this sign-in
  style.

### Updating the app

From `receipts-app/`:

```bash
sh test/run.sh                                  # ~2 seconds, no dependencies
git add -A && git commit -m "your change" && git push
```

GitHub Pages redeploys in about a minute. Open the app and tap
**Settings → App → Check for update** to pull it in straight away, or just
reopen the app.

Bump `APP_VERSION` in `app.js` and the matching `CACHE` name in `sw.js` when
you change the app, so the phone can tell you which build it is running and
old caches get retired.

`test/run.sh` checks the JavaScript parses, that every element `app.js` reaches
for actually exists in `index.html`, and that the scanner behaves when the
scanner is broken — it runs `app.js` and the Worker against a stubbed network
and asserts each failure produces the right diagnosis, that hopeless failures
are not retried, and that the form keeps working throughout. It needs nothing
but Node.

There is also a browser test, kept separate because it is the only thing here
with a dependency. It opens the actual app in Chromium and checks it boots
clean, that a dead scanner produces a readable explanation, that three failures
pause it, and that the service worker registers:

```bash
node test/serve.js &          # static server on :8099
npm install playwright-core   # Chromium itself is already on the machine
node test/browser.js
```
