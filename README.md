<p align="center">
  <img src="assets/icon.ico" width="110" alt="Heatmap app icon">
</p>

<h1 align="center">Heatmap</h1>

<p align="center">
  <b>Track your job hunt. Watch your momentum build.</b><br>
  A desktop widget that turns your job applications into a GitHub-style activity heatmap —
  so you can see your effort at a glance and keep the streak alive.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-41-47848f?logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/Node-20+-339933?logo=node.js&logoColor=white" alt="Node">
  <img src="https://img.shields.io/badge/Platform-Windows-0078d6?logo=windows&logoColor=white" alt="Windows">
  <img src="https://img.shields.io/badge/License-MIT-blue" alt="License">
</p>

---

## Why Heatmap?

Job hunting is a numbers game, and it's easy to lose sight of how much ground you've covered. Heatmap lives on your desktop and answers one question instantly: **am I keeping up the effort?**

Every application you log lights up a square. Quiet weeks show up as gaps; productive ones glow green. It's the same dopamine loop that keeps developers committing to GitHub — pointed at your career.

## What you get

- 🟩 **At-a-glance heatmap** — a rolling 4-month grid with intensity scaling and a live "sent · streak" counter, so progress is impossible to ignore.
- 🗂️ **Full application tracker** — a dedicated manager window to add, edit, search, filter, and sort every application, with a multi-select status pipeline (Applied → Interview → Offer).
- 📊 **Insights** — a conversion funnel and key metrics that turn your raw log into "where am I actually losing momentum?"
- ⏳ **Smart auto-reject** — applications that go silent for 100+ days are flagged as rejected automatically, so your stats reflect reality without manual cleanup.
- 🔄 **Optional Google Sheets sync** — already track applications in a spreadsheet? Connect it for two-way sync. Don't want to? The app is fully functional offline with a local database.
- ✨ **Polished desktop feel** — frosted-glass dark UI, system tray controls, pin-on-top, position memory, and auto-launch on login.
- ⬆️ **Auto-updates** — new versions download and install themselves from GitHub Releases.

## Local-first by design

Your data lives in a local database on your machine (`sql.js` / SQLite). Google Sheets is **entirely optional** — connect it if you want a cloud backup or already keep a spreadsheet, but everything works without it. No account, no setup wall, no internet required to log an application.

## Install

Download the latest installer from [**Releases**](https://github.com/Ahmed-Amamou/Heatmap/releases), run it, and you're tracking in seconds. Open the manager from the widget or tray to add your first application — no configuration required.

> Want spreadsheet sync? See [Connecting Google Sheets](#connecting-google-sheets-optional) below.

## Connecting Google Sheets (optional)

1. Create a [Google Service Account](https://console.cloud.google.com/iam-admin/serviceaccounts) and enable the **Google Sheets API**.
2. Download its JSON key.
3. Share your spreadsheet with the service account's email.
4. In the app's **Settings**, import the key and paste your spreadsheet ID.

Heatmap then syncs both ways — edits in the app push to the sheet, and the sheet's rows import back in.

## Run from source

```bash
git clone git@github.com:Ahmed-Amamou/Heatmap.git
cd Heatmap
npm install
npm start
```

**Preview the first-run experience** without touching your data:

```bash
npm run start:fresh        # launches an isolated, throwaway profile (empty DB, no sheet)
```

## Releasing a new version

```bash
# 1. Bump "version" in package.json
# 2. Tag and push:
git tag v1.1.0
git push origin v1.1.0
```

GitHub Actions builds the Windows installer and publishes it as a Release. Installed apps auto-update on their next launch.

## Tech stack

| Layer    | Tech                                   |
|----------|----------------------------------------|
| Shell    | Electron                               |
| Storage  | sql.js (SQLite, WASM) — local-first    |
| Sync     | Google Sheets API v4 (optional)        |
| Auth     | Service Account (OAuth2)               |
| Updates  | electron-updater + GitHub Releases     |
| CI/CD    | GitHub Actions                         |

## License

MIT
