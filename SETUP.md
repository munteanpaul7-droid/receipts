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
- Enter the total, then tap **Auto-calculate taxes from total** — it splits out
  TPS (5%) and TVQ (9.975%). Both stay editable; **No tax** zeroes them.
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
category, purpose, subtotal, TPS, TVQ, total, both registration numbers, the
file name and a direct link. Each picture also carries the same details in its
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

## Notes

- The app requests the `drive.file` permission only. It can see and touch
  **only the files and folders it created itself** — it cannot read the rest of
  your Drive.
- It creates the `receipts` folder itself on first save and remembers it. You
  can drag that folder anywhere in Drive afterwards, or rename it, and the app
  keeps writing to the same one.
- Folder name, tax rates, photo size and the year/month layout are all in
  **Settings**.
- Nothing passes through anyone else's server. The only two parties are your
  phone and Google.
- The consent screen is in *Testing* mode, which is correct here — it keeps the
  app private to the two test-user accounts. It does not expire this sign-in
  style.

### Updating the app

From `receipts-app/`:

```bash
git add -A && git commit -m "your change" && git push
```

GitHub Pages redeploys in about a minute; the phone picks up the new version
the second time you open it.
