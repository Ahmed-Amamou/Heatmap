# Heatmap

A minimal Electron desktop widget that visualizes your job application activity as a GitHub-style contribution heatmap. Pulls data from Google Sheets and stays on your desktop.

![Electron](https://img.shields.io/badge/Electron-33-47848f?logo=electron&logoColor=white)
![Node](https://img.shields.io/badge/Node-18+-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)

## Features

- **GitHub-style heatmap** — 4-month rolling grid with green intensity scaling
- **Glassmorphism UI** — frosted glass dark theme with smooth animations
- **Google Sheets sync** — reads application dates via service account
- **Settings UI** — configure spreadsheet, import credentials from the app
- **Auto-updater** — downloads new versions from GitHub Releases automatically
- **System tray** — refresh, pin, settings, quit from the tray icon
- **Auto-refresh** — pulls new data every 30 minutes
- **Position memory** — remembers where you placed the widget
- **Startup launch** — runs on Windows login automatically

## Install

Download the latest `.exe` from [Releases](https://github.com/Ahmed-Amamou/Heatmap/releases), run it, and configure from the settings panel inside the app.

## Setup from Source

```bash
git clone git@github.com:Ahmed-Amamou/Heatmap.git
cd Heatmap
npm install
npm start
```

**Google Sheets API** — Create a [Service Account](https://console.cloud.google.com/iam-admin/serviceaccounts), enable the Sheets API, download the key, and import it via the in-app Settings panel.

## Releasing a New Version

```bash
# Bump version in package.json, then:
git tag v1.1.0
git push origin v1.1.0
```

GitHub Actions builds the installer and publishes it as a Release. The app auto-updates on next launch.

## Tech Stack

| Layer | Tech |
|-------|------|
| Shell | Electron |
| Data | Google Sheets API v4 |
| Auth | Service Account (OAuth2) |
| Updates | electron-updater + GitHub Releases |
| CI/CD | GitHub Actions |

## License

MIT
