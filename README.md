# Toothpod ICP Survey

A short, on-brand customer survey for Toothpod that shows **one question at a
time**, with a progress bar, partial-answer capture, and automatic logging to a
Google Sheet. Built as a plain static site (HTML/CSS/JS) — no build step.

The welcome screen and **Q1** share the first page; questions **Q2–Q8** each get
their own step. A progress bar advances as the respondent moves forward, and the
welcome copy highlights that it's **~3 minutes / 8 questions**.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup for the welcome screen + all 8 questions (one per step). |
| `styles.css` | Toothpod brand styling (tokens sourced from the logo), wizard + progress bar. |
| `script.js` | Step navigation, validation, progress, and partial-answer capture. |
| `config.js` | Where you paste your deployed Apps Script Web App URL. |
| `assets/toothpod-logo-light.svg` | Toothpod wordmark. |
| `apps-script/Code.gs` | Google Apps Script backend that upserts responses into **Sheet1**. |

## How partial answers are captured

Each visitor gets a random **session id** (kept in `localStorage`). On every
step forward — and again if they close the tab mid-way — the survey POSTs the
*current* answers to the Apps Script endpoint. The backend **upserts a single
row per session** into `Sheet1`, so:

- Incomplete / abandoned responses are still recorded (the `Status` column shows
  `In progress` vs `Completed`).
- Refreshing the page resumes where the respondent left off.
- Each respondent is exactly one row, filled in progressively.

Until you connect an endpoint, the survey runs in **preview mode** and logs each
payload to the browser console (open DevTools to see it) — handy for testing.

## 1) Connect the Google Sheet (backend)

1. Open or create the Google Sheet that should hold responses. Its first tab is
   named **`Sheet1`** by default — that's what the script writes to.
2. In that sheet: **Extensions → Apps Script**.
3. Delete the placeholder, paste the contents of [`apps-script/Code.gs`](apps-script/Code.gs), and **Save**.
4. **Deploy → New deployment → Type: Web app**
   - **Execute as:** Me
   - **Who has access:** Anyone
   - **Deploy**, then authorize when prompted.
5. Copy the **Web app URL** (ends in `/exec`).
6. Paste it into [`config.js`](config.js):
   ```js
   window.TOOTHPOD_SURVEY_CONFIG = {
     endpoint: "https://script.google.com/macros/s/AKfy.../exec",
   };
   ```
7. Commit & push that change.

> After any later edit to `Code.gs`, redeploy a new version:
> **Deploy → Manage deployments → ✎ Edit → Version: New version → Deploy.**

## 2) Run it locally

It's a static site, so any static server works:

```bash
# from the project root
python3 -m http.server 8000
# then open http://localhost:8000
```

(Opening `index.html` via `file://` also works for the UI, but submissions to the
Apps Script endpoint need to be served over `http(s)://`.)

## 3) Publish with GitHub Pages (optional)

This repo is `Scale-Science/tp-icp-survey`. To host the survey:

1. **Settings → Pages**.
2. **Source:** Deploy from a branch.
3. **Branch:** `main` / root (`/`). Save.
4. Your survey will be live at `https://scale-science.github.io/tp-icp-survey/`.

## Editing questions

Questions live in two places that must stay in sync:

- The markup in `index.html` (one `<section class="step">` per question).
- The `QUESTIONS` array in `script.js` (used for validation + the column labels
  sent to the sheet).

If you add a question, the Apps Script automatically appends a new column the
first time that question's label shows up — no backend change needed.

---

© Toothpod. Branding cohesive with the
[Toothpod customer survey](https://havinfun47.github.io/tp-customer-survey/).
