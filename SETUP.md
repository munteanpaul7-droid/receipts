# Receipts — setup

An app for your iPhone that photographs a receipt, files the picture into
Google Drive under `receipts / 2026 / 2026-08 August`, and logs every amount,
tax and category into a spreadsheet.

It is a web app you install to your home screen. There is no server and no
account to create — your phone talks straight to Google Drive.

There are two jobs: **put the files online** (10 min) and **create a Google
credential** (5 min). You only ever do this once.

---

## Step 1 — Put the app online

The app must be on an `https://` address, because iPhone will not give camera
access or let Google sign you in otherwise. GitHub Pages is free and permanent.

1. Make a free account at <https://github.com> if you do not have one.
2. Click **+** (top right) → **New repository**.
   - Repository name: `receipts`
   - Set it to **Public**
   - Click **Create repository**
3. On the new page click **uploading an existing file**.
4. Drag in all 7 files from this `receipts-app` folder:
   `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`,
   `icon-180.png`, `icon-512.png`
   Then click **Commit changes**.
5. Go to the repo's **Settings** tab → **Pages** in the left sidebar.
   - Under *Build and deployment*, Source = **Deploy from a branch**
   - Branch = **main**, folder = **/ (root)** → **Save**
6. Wait about a minute, then reload that page. It will show your address:

   ```
   https://YOURNAME.github.io/receipts/
   ```

   Write that address down. That is your app.

---

## Step 2 — Create the Google credential

This is what lets the app write into *your* Drive and nobody else's.

1. Go to <https://console.cloud.google.com/> and sign in as
   **munteanpaul7@gmail.com**. Make sure you are signed in as that account and
   not another one — the app files into whichever account you authorize.
2. At the top, click the project dropdown → **New Project**.
   Name it `Receipts` → **Create**. Then make sure it is the selected project.
3. **Enable the Drive API.** Left menu → **APIs & Services** → **Library**.
   Search `Google Drive API` → open it → **Enable**.
4. **Set up the consent screen.** Left menu → **APIs & Services** →
   **OAuth consent screen** (newer consoles call this *Google Auth Platform →
   Branding*).
   - User type: **External** → Create
   - App name: `Receipts`
   - User support email: your email
   - Developer contact email: your email
   - Save and continue through the remaining pages.
   - On the **Audience / Test users** page, click **Add users** and add
     `munteanpaul7@gmail.com`. This matters — without it Google will refuse
     to sign you in.
5. **Create the credential.** Left menu → **Credentials** →
   **Create Credentials** → **OAuth client ID**.
   - Application type: **Web application**
   - Name: `Receipts iPhone`
   - Under **Authorized JavaScript origins** → Add URI:
     ```
     https://YOURNAME.github.io
     ```
     (just that — no `/receipts` on the end)
   - Under **Authorized redirect URIs** → Add URI:
     ```
     https://YOURNAME.github.io/receipts/
     ```
   - **Create**
6. Google shows you a **Client ID** ending in `.apps.googleusercontent.com`.
   Copy it. (You can always find it again under Credentials.)

> If you are unsure what to type in step 5, open the app on your phone first,
> go to **Settings**, and it prints the exact two lines under
> *Paste these into Google Cloud*, with a **Copy both** button.

---

## Step 3 — Install it on your iPhone

1. Open **Safari** (it must be Safari, not Chrome) and go to your address:
   `https://YOURNAME.github.io/receipts/`
2. Tap the **Share** button (square with an arrow) → **Add to Home Screen** →
   **Add**. You now have a Receipts icon like any other app.
3. Open it from the home screen. Go to **Settings**, paste your Client ID into
   the first box, and tap **Connect Drive**.
   - Google will warn *"Google hasn't verified this app."* That is expected —
     it is your own app. Tap **Advanced** → **Go to Receipts (unsafe)** →
     **Continue**.
   - If the popup does not come back properly, tap **Sign in without a popup**
     instead. That does the same thing with a full-page redirect, which is
     more reliable inside a home-screen app.
4. The dot at the top left turns **green**. You are done.

---

## Using it

- **Scan with camera** opens the camera. **From photos** picks an existing
  picture or a PDF.
- Fill in the total, then tap **Auto-calculate taxes from total** — it splits
  out TPS (5%) and TVQ (9.975%) for you. Both stay editable, and **No tax**
  zeroes them.
- Pick a category from the dropdown: Restaurant, Gas / Fuel, Groceries / Food,
  Furniture, Office supplies, Travel / Hotel, Vehicle / Maintenance,
  Utilities / Telecom, Professional services, Software / Subscriptions,
  Tools / Equipment, Advertising / Marketing, Other.
- The TPS and TVQ registration numbers are optional, and are remembered per
  merchant — type the same shop name next time and they fill themselves in.
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

Open `receipts-index.csv` with Google Sheets and you have date, merchant,
category, purpose, subtotal, TPS, TVQ, total, both registration numbers, the
file name and a direct link. Each picture also carries the same details in its
Drive *description*, so searching Drive for a merchant or amount finds it.

A manual entry with no photo is saved as a small `.txt` in the same folder, so
the month folder always matches the spreadsheet.

### If you have no signal

Save it anyway. Receipts are stored on the phone and an hourglass appears in
the top bar. They upload by themselves the next time you open the app on wifi,
or you can tap **History → Retry pending uploads**. Nothing is lost if an
upload fails — the photo is only cleared once Drive confirms it.

Google sign-ins last about an hour. If it has lapsed, saving still works and
just queues; open Settings and tap **Connect Drive** to flush the queue.

---

## Notes

- The app asks for the `drive.file` permission only. That means it can see and
  touch **only the files and folders it created itself** — it cannot read the
  rest of your Drive. Ticking that box is not giving it your whole account.
- It creates the folder itself and remembers it. If you already have a folder
  called `receipts`, this app will make its own — after the first save, you can
  drag it wherever you want in Drive, or rename it, and the app keeps writing
  to the same one.
- To change the folder name, tax rates, photo size, or the year/month layout,
  use **Settings** in the app.
- Nothing about your receipts passes through anyone else's server. The only two
  parties are your phone and Google.
- To update the app later, upload the changed files to the same GitHub repo.
  The phone picks up the new version the second time you open it.
