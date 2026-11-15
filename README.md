# Despair Downloader

Internal desktop tool (Electron, Windows) for despair-world.com admins/sub-admins
to upload anime episode video files directly to EarnVid, Doodstream and Voe in
parallel — bypassing the CORS limitations a browser-based upload hits, since
all three hosts are called from Electron's Node main process instead of a
renderer.

## Features
- Login with your despair-world.com admin/sub-admin account (email + password).
- Anime tab: search existing works, or create a new one via AniList.
- Upload tab: single episode or a whole folder (range of episode numbers),
  with automatic "already uploaded to X — replace?" checks per host.
- Operations tab: persisted table of every upload, per-host status/progress/
  error, with a per-host retry button.
- Runs in the system tray; uploads continue after the window is closed.
- Auto-updates via GitHub Releases.

## Setup
```
npm install
npm start
```
Enter your three host API keys once in Settings — they're stored locally.

## Build / release
```
npm run build      # local .exe, no publish
npm run release     # builds and publishes to GitHub Releases (needs GH_TOKEN env var)
```
