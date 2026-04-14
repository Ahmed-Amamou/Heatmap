# Heatmap

A minimal Electron desktop widget that visualizes your job application activity as a GitHub-style contribution heatmap. Pulls data from Google Sheets and stays on your desktop.

![Electron](https://img.shields.io/badge/Electron-33-47848f?logo=electron&logoColor=white)
![Node](https://img.shields.io/badge/Node-18+-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)

## Features

- **GitHub-style heatmap** — 4-month rolling grid with green intensity scaling
- **Google Sheets sync** — reads application dates from your spreadsheet via service account
- **Streak counter** — tracks consecutive days of applications
- **System tray** — refresh, pin on top, or quit from the tray icon
- **Auto-refresh** — pulls new data every 30 minutes
- **Frameless & draggable** — clean overlay widget with dark theme

## Setup

**1. Clone & install**

```bash
git clone git@github.com:Ahmed-Amamou/Heatmap.git
cd Heatmap
npm install
```

**2. Google Sheets API**

- Create a [Service Account](https://console.cloud.google.com/iam-admin/serviceaccounts) and enable the Sheets API
- Download the key as `credentials.json` into the project root
- Share your spreadsheet with the service account email

**3. Configure `.env`**

```env
SPREADSHEET_ID=your_spreadsheet_id
SHEET_NAME=Sheet1
DATE_COLUMN=F
```

**4. Run**

```bash
npm start
```

## Tech Stack

| Layer | Tech |
|-------|------|
| Shell | Electron |
| Data | Google Sheets API v4 |
| Auth | Service Account (OAuth2) |
| Config | dotenv |

## License

MIT
